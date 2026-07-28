import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion, AnimatePresence } from 'framer-motion'
import { AlertCircle, Info, Loader2, Lock, Shield } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { logLogin } from '@/features/access/accessApi'
import { GOOGLE_OAUTH_SCOPE } from '@/lib/googleScopes'

declare global {
  interface Window { google?: any }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client'
const HERO = '/login-hero.png'
const LOGO = '/logo-circular-sebratel.png'
const EASE = [0.22, 1, 0.36, 1] as const

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.25 1.3-1 2.4-2.1 3.1l3.4 2.6c2-1.8 3.1-4.5 3.1-7.7 0-.75-.07-1.5-.2-2.2H12z" />
      <path fill="#34A853" d="M5.8 14.1l-.9.7-2.5 1.9C4.2 20.8 7.9 23 12 23c3 0 5.5-1 7.3-2.7l-3.4-2.6c-.9.6-2.1 1-3.9 1-3 0-5.5-2-6.4-4.7z" />
      <path fill="#FBBC05" d="M5.5 9.3 2.9 7.1C1.1 10.4 1.1 14.3 2.9 17.6l2.6-2c-.4-1.2-.4-2.5 0-3.7z" />
      <path fill="#4285F4" d="M12 5.8c1.7 0 3.2.6 4.4 1.8l3.3-3.3C16.5 2.1 14.4 1 12 1 7.9 1 4.2 3.2 2.9 7.1l2.6 2C6.5 7.4 9.1 5.8 12 5.8z" />
    </svg>
  )
}

function HeroAmbientDecor({ reduced }: { reduced: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {!reduced && (
        <>
          <motion.div
            className="absolute -left-[15%] top-[18%] h-[min(85vw,520px)] w-[min(85vw,520px)] rounded-full bg-primary/20 blur-[88px]"
            animate={{ opacity: [0.28, 0.48, 0.28], scale: [1, 1.06, 1] }}
            transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute -right-[8%] bottom-[12%] h-[min(70vw,420px)] w-[min(70vw,420px)] rounded-full bg-secondary/16 blur-[72px]"
            animate={{ opacity: [0.22, 0.42, 0.22], x: [0, -12, 0], y: [0, 8, 0] }}
            transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
          />
        </>
      )}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_75%_55%_at_45%_42%,rgba(255,176,0,0.14),transparent_68%)] mix-blend-screen" />
    </div>
  )
}

export default function LoginPage() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  const navigate = useNavigate()
  const setUser = useAuthStore((s) => s.setUser)
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const reduced = !!useReducedMotion()
  const tokenClientRef = useRef<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!clientId) { setError('VITE_GOOGLE_CLIENT_ID não configurado no .env.'); return }

    function init() {
      const oauth2 = window.google?.accounts?.oauth2
      if (!oauth2) return
      tokenClientRef.current = oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_OAUTH_SCOPE,
        callback: async (resp: { access_token?: string }) => {
          if (!resp.access_token) { setBusy(false); return }
          try {
            const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${resp.access_token}` },
            })
            const p = await r.json()
            setUser({ name: p.name ?? p.email, email: p.email, picture: p.picture })
            setAccessToken(resp.access_token)
            logLogin().catch(() => {})
            navigate('/', { replace: true })
          } catch {
            setError('Falha ao obter os dados da conta Google.')
            setBusy(false)
          }
        },
        error_callback: () => setBusy(false),
      })
    }

    if (window.google?.accounts?.oauth2) { init(); return }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    if (script) { script.addEventListener('load', init); return }
    script = document.createElement('script')
    script.src = GSI_SRC; script.async = true; script.defer = true
    script.onload = init
    script.onerror = () => setError('Não foi possível carregar o Google Sign-In.')
    document.head.appendChild(script)
  }, [clientId, navigate, setUser, setAccessToken])

  const handleGoogle = () => {
    if (!tokenClientRef.current) { setError('Google Sign-In ainda não carregou. Tente novamente.'); return }
    setError(null)
    setBusy(true)
    tokenClientRef.current.requestAccessToken()
  }

  return (
    <div className="relative min-h-svh w-full overflow-hidden bg-[#0c0a08] text-on-surface">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <motion.div
          className="absolute inset-[-3%] bg-cover bg-[center_32%] bg-no-repeat sm:bg-[left_28%_center] lg:bg-[left_22%_center]"
          style={{ backgroundImage: `url(${HERO})` }}
          animate={reduced ? undefined : { scale: [1, 1.032, 1] }}
          transition={{ duration: 36, repeat: Infinity, ease: 'easeInOut' }}
        />
        <HeroAmbientDecor reduced={reduced} />
        <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/45 to-[#0f0d0b]/70" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-black/40" />
        <div className="absolute inset-0 bg-black/15" />
      </div>

      <div className="relative z-10 flex min-h-svh w-full flex-col pb-16 lg:flex-row lg:items-center lg:pb-20">
        <div className="order-1 flex flex-col gap-4 px-6 pt-10 text-[#fff] lg:min-h-svh lg:flex-1 lg:justify-end lg:pb-32 lg:pl-10 lg:pr-6 lg:pt-0 xl:pl-14">
          <motion.div
            className="flex items-center gap-3 drop-shadow-md"
            initial={reduced ? false : { opacity: 0, x: -14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <img src={LOGO} alt="" width={44} height={44} className="h-11 w-11 rounded-full object-contain ring-1 ring-[#fff]/40 shadow-lg" aria-hidden />
            <span className="text-base font-extrabold uppercase tracking-[0.24em] text-[#fff] drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)] sm:text-lg">INDICADORES SEBRATEL</span>
          </motion.div>
          <motion.h2
            className="max-w-xl text-balance text-2xl font-bold leading-[1.15] tracking-tight text-[#fff] drop-shadow-[0_2px_12px_rgba(0,0,0,0.75)] sm:text-3xl lg:text-[2rem] xl:text-4xl"
            initial={reduced ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08, ease: EASE }}
          >
            A conexão que move <span className="text-[#FFC107]">o que importa.</span>
          </motion.h2>
          <motion.p
            className="max-w-md text-sm leading-relaxed text-[#fff] drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)] sm:text-base"
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.16, ease: EASE }}
          >
            Tecnologia e pessoas conectadas para levar o melhor todos os dias.
          </motion.p>
        </div>

        <div className="order-2 flex w-full flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6 lg:w-[min(100%,460px)] lg:flex-none lg:px-8 xl:pr-16 motion-safe:-translate-x-5 lg:motion-safe:-translate-x-12">
          <motion.div
            className="relative z-10 w-full max-w-[440px]"
            initial={reduced ? false : { opacity: 0, y: 36, scale: 0.96, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.58, ease: EASE, delay: 0.06 }}
          >
            <motion.div
              className="relative overflow-hidden rounded-2xl border border-[#fff]/60 bg-[#FBFAF5] shadow-[0_36px_72px_-12px_rgba(0,0,0,0.62)] ring-1 ring-black/5 sm:rounded-3xl"
              animate={error && !reduced ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/45 to-transparent" />

              <div className="relative space-y-6 p-7 sm:p-8">
                <header className="space-y-2">
                  <span className="inline-flex rounded-full border border-amber-300/70 bg-amber-100 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-900">
                    INDICADORES SEBRATEL
                  </span>
                  <h1 className="text-2xl font-bold tracking-tight text-on-surface sm:text-[1.65rem]">Acessar plataforma</h1>
                  <p className="text-sm leading-relaxed text-neutral-700">
                    Acesso com conta Google para controle de permissões.
                  </p>
                </header>

                <div className="rounded-2xl border border-amber-300/80 bg-[#FFFBEB] p-4 shadow-sm">
                  <div className="flex items-center justify-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/50 bg-amber-100/80 text-primary">
                      <Shield className="h-5 w-5" strokeWidth={2} aria-hidden />
                    </div>
                    <p className="text-base text-on-surface">
                      Domínio liberado para:{' '}
                      <span className="font-semibold text-on-surface">@sebratel.com.br</span>
                    </p>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {error && (
                    <motion.div
                      role="alert"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2 }}
                      className="flex gap-2 rounded-xl border border-rose-200/90 bg-rose-50/95 px-3 py-2.5 text-sm text-rose-900 shadow-sm"
                    >
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                      <span>{error}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                <motion.button
                  type="button"
                  onClick={handleGoogle}
                  disabled={busy}
                  aria-busy={busy}
                  whileHover={reduced || busy ? undefined : { scale: 1.02, y: -1 }}
                  whileTap={reduced || busy ? undefined : { scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 28 }}
                  className="group relative flex min-h-[44px] w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-[#FFB800] px-4 py-3.5 text-sm font-semibold text-on-surface shadow-md transition-shadow hover:bg-[#e6a800] hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="relative z-10 h-5 w-5 animate-spin text-on-surface" aria-hidden />
                  ) : (
                    <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#fff] shadow-sm ring-1 ring-black/5">
                      <GoogleMark className="h-5 w-5" />
                    </span>
                  )}
                  <span className="relative z-10">{busy ? 'A autenticar…' : 'Entrar com Google'}</span>
                </motion.button>

                <p className="text-center text-[11px] text-on-surface-variant">
                  <a
                    href="mailto:?subject=Acesso%20Indicadores%20Sebratel%20%E2%80%94%20suporte&body=Descreva%20o%20problema%20e%20o%20seu%20e-mail%20corporativo."
                    className="inline-flex items-center justify-center gap-1.5 font-medium text-primary underline-offset-2 transition hover:text-secondary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Info className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
                    Problemas para acessar?
                  </a>
                </p>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>

      <footer className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 border-t border-[#fff]/10 bg-black/55 py-2.5 text-center text-[11px] text-[#fff]/90 backdrop-blur-md supports-[backdrop-filter]:bg-black/40">
        <span className="inline-flex items-center justify-center gap-2 px-4">
          <Lock className="h-3.5 w-3.5 shrink-0 opacity-90" strokeWidth={2} aria-hidden />
          Ambiente seguro e monitorado.
        </span>
      </footer>
    </div>
  )
}
