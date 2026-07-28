import { createPortal } from 'react-dom'

// Renderiza direto em document.body — um modal com position:fixed dentro da
// árvore normal do app pode ficar "preso" ao containing block de qualquer
// ancestral com transform/filter/contain (ex. uma animação de entrada que
// termina com transform diferente de 'none'), cortando/deslocando o overlay
// em vez de cobrir a tela inteira. O portal elimina essa dependência.
export function ModalPortal({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body)
}
