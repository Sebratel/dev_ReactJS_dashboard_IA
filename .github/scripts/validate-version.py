#!/usr/bin/env python3
"""Valida a versao do projeto (pom.xml no Maven/Java, package.json no Node) antes de construir a imagem.
Falha (exit 1) se:

  1. (Maven) o pom raiz nao declara <version> propria (herdada ou ausente) ou usa placeholder (${revision});
  2. a versao e -SNAPSHOT/pre-release ou nao segue X.Y.Z;
  3. (Maven) um modulo declara versao/parent diferente da raiz;
  4. a versao ja esta em uso: existe a tag git vX.Y.Z em OUTRO commit, ou a imagem IMAGE:X.Y.Z ja foi publicada;
  5. (Node) o package-lock.json ou a versao literal do compose (${APP_VERSION:-X.Y.Z}) diferem do package.json;
  6. a versao NAO e estritamente MAIOR que a da branch base (BASE_REF, ex.: origin/staging; ou BASE_SHA = commit
     anterior, em um push): todo commit que sobe para um ambiente tem versao maior que a que esta la.
     Igual ou menor falha.

Projeto novo comeca em 1.0.0. Reexecutar o mesmo commit (re-run do CI) e permitido: a tag aponta para o proprio commit.

Variaveis:
  IMAGE          ex.: ghcr.io/sebratel/api-gateway. Obrigatoria no Maven; opcional no Node (sem ela nao consulta o registry)
  BASE_REF       ref da base (origin/staging, origin/main) ou BASE_SHA (github.event.before). Sem nenhuma, a regra 6 e
                 pulada com aviso
  COMPOSE        compose a conferir no Node (padrao docker-compose.portainer.yml)
  GITHUB_SHA     padrao: HEAD
  CHECK_REGISTRY false para pular a consulta ao registry (uso local)
  GITHUB_OUTPUT  recebe version=X.Y.Z
Sem dependencias alem do Python 3, git e (opcional) docker.
"""
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

NS = {"m": "http://maven.apache.org/POM/4.0.0"}
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
errors = []


def fail(msg):
    errors.append(msg)


def text(node, path):
    el = node.find(path, NS)
    return el.text.strip() if el is not None and el.text else None


def root_of(pom):
    return ET.parse(pom).getroot()


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def vtuple(v):
    return tuple(int(p) for p in v.split("."))


def base_version(ref, node):
    """Versao do manifesto em `ref` (None se o manifesto ou a versao nao existirem la)."""
    r = run(["git", "show", f"{ref}:{'package.json' if node else 'pom.xml'}"])
    if r.returncode != 0:
        return None
    try:
        if node:
            return json.loads(r.stdout).get("version")
        el = ET.fromstring(r.stdout).find("m:version", NS)
        return el.text.strip() if el is not None and el.text else None
    except Exception:
        return None


def check_greater(version, node):
    ref = os.environ.get("BASE_REF", "").strip() or os.environ.get("BASE_SHA", "").strip()
    if not ref or set(ref) == {"0"}:
        print("::warning::BASE_REF/BASE_SHA nao definidos: a regra 'versao maior que a do ambiente' foi pulada.")
        return
    base = base_version(ref, node)
    if not base or not SEMVER.match(base) or not SEMVER.match(version):
        return
    if vtuple(version) <= vtuple(base):
        fail(f"a versao {version} nao e MAIOR que a que esta em {ref} ({base}). Todo commit que sobe para um ambiente "
             "precisa de versao maior que a atual dele: aumente a versao (patch, minor ou major conforme o impacto).")


def check_node():
    """package.json: X.Y.Z, igual no package-lock.json e no literal do compose. Devolve a versao."""
    version = json.load(open("package.json", encoding="utf-8")).get("version")
    if not version:
        fail('package.json: sem "version". Projeto novo comeca em 1.0.0.')
        return None
    if not SEMVER.match(version):
        fail(f"package.json: a versao '{version}' nao segue o formato X.Y.Z (sem -beta, -SNAPSHOT etc.).")
        return None
    if os.path.exists("package-lock.json"):
        lock = json.load(open("package-lock.json", encoding="utf-8"))
        top = lock.get("version")
        pkg = (lock.get("packages") or {}).get("", {}).get("version")
        for onde, v in (("package-lock.json", top), ('package-lock.json packages[""]', pkg)):
            if v is not None and v != version:
                fail(f"{onde} esta em '{v}' e o package.json em '{version}': use o script de versao do projeto "
                     "(ex.: npm run version:set).")
    compose = os.environ.get("COMPOSE", "docker-compose.portainer.yml")
    if os.path.exists(compose):
        found = set(re.findall(r"APP_VERSION:-(\d+\.\d+\.\d+)\}", open(compose, encoding="utf-8").read()))
        if not found:
            fail(f"{compose}: sem '${{APP_VERSION:-{version}}}' na tag da imagem: o Portainer nao saberia a versao da aplicacao.")
        for v in sorted(found - {version}):
            fail(f"{compose}: APP_VERSION padrao '{v}' difere do package.json '{version}'.")
    return version


def check_maven():
    root = root_of("pom.xml")
    version = text(root, "m:version")
    if not version:
        fail("pom.xml: o projeto nao declara <version> propria (nao basta herdar do parent). Declare uma versao X.Y.Z.")
    elif "${" in version:
        fail(f"pom.xml: a versao '{version}' usa placeholder; declare a versao literal X.Y.Z.")
    elif version.upper().endswith("-SNAPSHOT"):
        fail(f"pom.xml: a versao '{version}' e SNAPSHOT. Imagens so saem de versoes de release X.Y.Z.")
    elif not SEMVER.match(version):
        fail(f"pom.xml: a versao '{version}' nao segue o formato X.Y.Z.")
    if version:
        artifact = text(root, "m:artifactId")
        for module in [m.text.strip() for m in root.findall("m:modules/m:module", NS) if m.text]:
            pom = os.path.join(module, "pom.xml")
            if not os.path.exists(pom):
                continue
            node = root_of(pom)
            own = text(node, "m:version")
            parent_version = text(node, "m:parent/m:version")
            parent_artifact = text(node, "m:parent/m:artifactId")
            if own and own != version:
                fail(f"{pom}: versao '{own}' diferente da raiz '{version}'.")
            if parent_artifact == artifact and parent_version != version:
                fail(f"{pom}: <parent> aponta para '{parent_version}', mas a raiz esta em '{version}'.")
    return version


def main():
    node = not os.path.exists("pom.xml") and os.path.exists("package.json")
    image = os.environ.get("IMAGE", "").strip()
    if not image and not node:
        sys.exit("Defina IMAGE (ex.: ghcr.io/sebratel/api-gateway).")
    sha = os.environ.get("GITHUB_SHA") or run(["git", "rev-parse", "HEAD"]).stdout.strip()
    check_registry = os.environ.get("CHECK_REGISTRY", "true").lower() != "false"

    version = check_node() if node else check_maven()

    if version and not errors:
        check_greater(version, node)

    if version and not errors and (image or not node):
        tag = f"v{version}"
        out = run(["git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"]).stdout.split()
        # linhas "sha ref"; para tag anotada vale o sha de ^{} (commit apontado)
        shas = {out[i + 1]: out[i] for i in range(0, len(out) - 1, 2)}
        tagged = shas.get(f"refs/tags/{tag}^{{}}") or shas.get(f"refs/tags/{tag}")
        if tagged and tagged != sha:
            fail(f"a versao {version} ja esta em uso: a tag {tag} aponta para {tagged[:7]}, nao para este commit ({sha[:7]}). "
                 "Aumente a versao.")
        elif not tagged and check_registry and image:
            probe = run(["docker", "manifest", "inspect", f"{image}:{version}"])
            if probe.returncode == 0:
                fail(f"a versao {version} ja esta em uso: a imagem {image}:{version} ja foi publicada. Aumente a versao.")

    if errors:
        for e in errors:
            print(f"::error::{e}")
        sys.exit(1)

    print(f"OK: versao {version} valida" + (f" e livre para {image}" if image else ""))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"version={version}\n")


if __name__ == "__main__":
    main()
