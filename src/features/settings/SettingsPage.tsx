// Configurações — as fontes de dados do Builder, o provedor de IA e o
// dicionário de dados.
//
// A fonte de dado corporativo é UMA: os datasets publicados no Data Hub
// (lakehouse), cadastrados no card abaixo. Existia antes um catálogo de
// queries SQL que batia direto no Postgres do ERP e no MariaDB, editável nesta
// mesma tela; ele foi removido porque manter os dois caminhos significava
// consumir duas plataformas grandes pela mesma informação — o lakehouse é o
// barramento. Planilhas do Google seguem existindo, cadastradas dentro do
// editor de widget, para dado que ninguém vai publicar no Data Hub.
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { fetchFolders } from '@/features/workspace/workspaceApi'
import type { Folder } from '@/features/workspace/types'
import { FieldDictionaryCard } from './FieldDictionaryCard'
import { LakehouseSourcesCard } from './LakehouseSourcesCard'
import { AiProviderCard } from './AiProviderCard'

export default function SettingsPage() {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  // Só alimenta o seletor de pastas do admin (em qual pasta cada fonte pode
  // ser usada) — /api/workspace/folders é admin-only, então nem tentamos
  // buscar se o usuário não for admin.
  const [allFolders, setAllFolders] = useState<Folder[] | null>(null)
  // Sobe quando o card de fontes termina de mexer no catálogo E o ETL já
  // reescreveu o snapshot — é o gatilho pro dicionário reler os campos em vez
  // de continuar mostrando o que existia quando a tela abriu.
  const [sourcesVersion, setSourcesVersion] = useState(0)

  useEffect(() => {
    if (!isAdmin) { setAllFolders([]); return }
    let alive = true
    fetchFolders()
      .then((f) => { if (alive) setAllFolders(f) })
      .catch(() => { if (alive) setAllFolders([]) })
    return () => { alive = false }
  }, [isAdmin])

  if (allFolders === null) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-card px-5 py-16 text-sm text-gray-400 animate-slide-up">
        <Loader2 size={16} className="animate-spin" /> Carregando configurações…
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-slide-up">
      <LakehouseSourcesCard allFolders={allFolders} onSourcesChanged={() => setSourcesVersion((v) => v + 1)} />
      {/* Provedor de IA e dicionário são os dois cards de admin. O provedor vem
          primeiro porque é o que decide gasto — e é onde alguém vai olhar
          quando a IA parar de responder. */}
      {isAdmin && <AiProviderCard />}
      {isAdmin && <FieldDictionaryCard reloadKey={sourcesVersion} />}
    </div>
  )
}
