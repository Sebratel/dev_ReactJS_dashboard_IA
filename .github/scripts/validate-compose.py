#!/usr/bin/env python3
"""Valida o docker-compose de um deploy no Portainer contra as regras de nomes e de ambiente da Sebratel.

Uso: validate-compose.py --repo <nome-do-repositorio> --env staging|production [--exceptions arquivo] compose.yml [...]

Regras (erro = exit 1):
  C1  `name:` no topo do compose existe e e o nome do repositorio no GitHub EM MINUSCULAS (= nome da stack no Portainer;
      o Compose recusa maiusculas em `-p`, que e o que o Portainer passa).
  C2  nenhum servico define `container_name` (o Compose gera <stack>-<servico>-<n>).
  C3  nome de servico em minusculas com hifens e sem o nome do repositorio nem palavras de ambiente
      (staging, stage, prod, production, portainer): o nome e o PAPEL (frontend, backend, redis, mysql...).
  C4  o compose nao aponta para o gateway de outro ambiente: staging nao pode conter o gateway de producao
      e producao nao pode conter o de staging.
Aviso (nao falha): C5  nome de servico fora da lista de papeis conhecidos.
Aviso (nao falha; erro com --strict-ports): C6  porta do host publicada fora da faixa da categoria do papel
      (ver references/portas.md). So avalia portas com valor literal ou default `${VAR:-porta}`.

Excecoes ja existentes ficam num arquivo (uma por linha): `<arquivo>:<regra>[:<servico>]  # motivo`.
Uma excecao e uma pendencia de migracao registrada, nao uma licenca: o CI as lista a cada execucao.
Requer Python 3 e PyYAML (ja presentes no ubuntu-latest).
"""
import argparse
import os
import re
import sys

import yaml

PROD_GATEWAY = "api-gateway-bff.sebratel.net.br"
STAGING_GATEWAY = "api-gateway-bff-staging.sebratel.net.br"
FORBIDDEN_WORDS = ("staging", "stage", "prod", "production", "portainer")
NAME_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
KNOWN_ROLES = {"frontend", "backend", "bff", "api", "worker", "scheduler", "redis", "mysql", "mariadb", "postgres",
               "mongo", "rabbitmq", "kafka", "elasticsearch", "nginx", "lb", "proxy", "prometheus", "grafana",
               "gateway", "migrations"}


# Faixas de porta do host por papel (references/portas.md). Papel fora daqui nao e avaliado.
ROLE_RANGES = {
    "frontend": (3000, 3099, "Frontend / Web UI"),
    "backend": (3100, 3199, "Backend / API"),
    "api": (3100, 3199, "Backend / API"),
    "bff": (3200, 3299, "BFF / Gateway"),
    "gateway": (3200, 3299, "BFF / Gateway"),
    "postgres": (5400, 5499, "Banco de dados"),
    "mysql": (5400, 5499, "Banco de dados"),
    "mariadb": (5400, 5499, "Banco de dados"),
    "redis": (6370, 6379, "Cache"),
    "kafka": (6390, 6399, "Fila de mensagens"),
    "prometheus": (9080, 9099, "Observabilidade: metricas/APM"),
    "grafana": (9080, 9099, "Observabilidade: metricas/APM"),
}
VAR_DEFAULT_RE = re.compile(r"\$\{[^}:-]+:?-([^}]*)\}")


def host_ports(cfg):
    """Portas do host (int) publicadas por um servico; ignora o que nao tem valor literal."""
    found = []
    for entry in cfg.get("ports") or []:
        if isinstance(entry, dict):
            value = entry.get("published")
        else:
            text = VAR_DEFAULT_RE.sub(r"\1", str(entry)).split("/", 1)[0]
            parts = text.split(":")
            value = parts[-2] if len(parts) >= 2 else None
        try:
            found.append(int(value))
        except (TypeError, ValueError):
            continue
    return found


def load_exceptions(path):
    ex = set()
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.split("#", 1)[0].strip()
            if line:
                ex.add(line)
    return ex


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--env", required=True, choices=["staging", "production"])
    ap.add_argument("--exceptions")
    ap.add_argument("--strict-ports", action="store_true", help="C6 (faixa de portas) vira erro em vez de aviso")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    exceptions = load_exceptions(args.exceptions)
    errors, pending, warnings = [], [], []

    def report(f, code, service, msg):
        keys = {f"{f}:{code}", f"{f}:{code}:{service}"} if service else {f"{f}:{code}"}
        if keys & exceptions:
            pending.append(f"{f} [{code}] {msg}")
        else:
            errors.append(f"{f} [{code}] {msg}")

    for f in args.files:
        raw = open(f, encoding="utf-8").read()
        doc = yaml.safe_load(raw) or {}
        name = doc.get("name")
        expected = args.repo.lower()
        if name != expected:
            report(f, "C1", None, f"`name:` deve ser o nome do repositorio em minusculas '{expected}' (encontrado: {name!r}).")
        for svc, cfg in (doc.get("services") or {}).items():
            cfg = cfg or {}
            if "container_name" in cfg:
                report(f, "C2", svc, f"servico '{svc}' define container_name '{cfg['container_name']}'; remova (o Compose nomeia).")
            if not NAME_RE.match(svc):
                report(f, "C3", svc, f"nome de servico '{svc}' invalido (minusculas e hifens).")
            low = svc.lower()
            if args.repo.lower() in low or any(w in low.split("-") or w in low for w in FORBIDDEN_WORDS):
                report(f, "C3", svc, f"servico '{svc}' nao deve conter o nome do repositorio nem palavra de ambiente; use o papel.")
            if svc not in KNOWN_ROLES:
                warnings.append(f"{f} [C5] servico '{svc}' fora dos papeis conhecidos ({', '.join(sorted(KNOWN_ROLES))}).")
            if svc in ROLE_RANGES:
                lo, hi, category = ROLE_RANGES[svc]
                for port in host_ports(cfg):
                    if not lo <= port <= hi:
                        msg = (f"servico '{svc}' publica a porta {port}; a faixa de {category} e {lo}-{hi} "
                               f"(references/portas.md). Se nao precisa ser alcancado de fora da stack, remova `ports:`.")
                        if args.strict_ports:
                            report(f, "C6", svc, msg)
                        elif f"{f}:C6" not in exceptions and f"{f}:C6:{svc}" not in exceptions:
                            warnings.append(f"{f} [C6] {msg}")
                        else:
                            pending.append(f"{f} [C6] {msg}")
        if args.env == "staging" and PROD_GATEWAY in raw:
            report(f, "C4", None, f"compose de STAGING aponta para o gateway de producao ({PROD_GATEWAY}); use {STAGING_GATEWAY}.")
        if args.env == "production" and "-staging.sebratel.net.br" in raw:
            report(f, "C4", None, "compose de PRODUCAO aponta para um endereco de staging.")

    for w in warnings:
        print(f"::warning::{w}")
    for p in pending:
        print(f"::warning::PENDENTE DE MIGRACAO (isento): {p}")
    if errors:
        for e in errors:
            print(f"::error::{e}")
        sys.exit(1)
    print(f"OK: {len(args.files)} compose(s) validados ({len(pending)} pendencia(s) isenta(s), {len(warnings)} aviso(s)).")


if __name__ == "__main__":
    main()
