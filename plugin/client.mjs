import { createElement,useEffect,useRef,useState } from 'react'
import { createLaunchAction,isLocalManager } from './client-action.mjs'

const messages = Object.freeze({
  zh:{ title:'DSH Mobile iroh',description:'连接当前 DSH，在独立浏览器页管理 iroh 配对与连接。',open:'打开管理',busy:'正在打开…',opened:'已在浏览器中打开管理页。',error:'未能打开管理页。请确认 DSH Mobile 已启用，再重试。' },
  en:{ title:'DSH Mobile iroh',description:'Manage iroh pairing and connections for this DSH in a separate browser page.',open:'Open manager',busy:'Opening…',opened:'The manager opened in your browser.',error:'Could not open the manager. Make sure DSH Mobile is enabled, then retry.' },
  it:{ title:'DSH Mobile iroh',description:'Gestisci associazioni e connessioni iroh per questo DSH in una pagina del browser separata.',open:'Apri gestione',busy:'Apertura…',opened:'La gestione è aperta nel browser.',error:'Impossibile aprire la gestione. Verifica che DSH Mobile sia attivo e riprova.' },
})
const language = () => document.documentElement.lang.startsWith('zh') ? 'zh' : document.documentElement.lang.startsWith('it') ? 'it' : 'en'
const styles = `
.dsh-iroh-settings-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e7eb);color:var(--dsw-alias-label-primary,#171717)}
.dsh-iroh-settings-copy{flex:1;min-width:0}
.dsh-iroh-settings-title{font-size:14px;line-height:20px}
.dsh-iroh-settings-description{margin-top:4px;color:var(--dsw-alias-label-secondary,#737373);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-iroh-settings-row button{flex-shrink:0;min-height:44px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;font:inherit;cursor:pointer}
.dsh-iroh-settings-row button:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f4f5)}
.dsh-iroh-settings-row button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:2px}
.dsh-iroh-settings-row button:disabled{cursor:wait;opacity:.6}
@media(max-width:480px){.dsh-iroh-settings-row{align-items:flex-start;flex-wrap:wrap}.dsh-iroh-settings-copy{flex-basis:100%}}`

function SettingsAction() {
  const [state,setState] = useState('idle'),[locale,setLocale] = useState(language),action = useRef()
  useEffect(() => {
    const controller = createLaunchAction({ onChange:setState,send:async signal => {
      const response = await fetch('/api/dsh-mobile-iroh/launch',{ method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,
        headers:{ 'Content-Type':'application/json','X-DSH-Iroh-Admin':location.protocol === 'dsh-app:' ? 'dsh-app://app' : 'same-origin-json' },body:'{"version":1}' })
      const result = await response.json()
      if (!response.ok || result.version !== 1 || result.opened !== true) throw new Error('iroh_open_failed')
    } })
    action.current = controller
    const observer = new MutationObserver(() => setLocale(language()))
    observer.observe(document.documentElement,{ attributes:true,attributeFilter:['lang'] })
    return () => { controller.close(); observer.disconnect(); if (action.current === controller) action.current = undefined }
  },[])
  const copy = messages[locale]
  return createElement('div',{ className:'dsh-iroh-settings-row','aria-busy':state === 'busy',lang:locale },
    createElement('div',{ className:'dsh-iroh-settings-copy' },
      createElement('div',{ className:'dsh-iroh-settings-title' },copy.title),
      createElement('div',{ className:'dsh-iroh-settings-description',role:'status','aria-live':'polite' },copy[state] ?? copy.description)),
    createElement('button',{ type:'button',disabled:state === 'busy',onClick:() => { void action.current?.run() } },state === 'busy' ? copy.busy : copy.open))
}

export const inject = ['slots']

/** Register one scoped settings action; no DOM/private-component replacement. */
export function apply(ctx) {
  if (!isLocalManager(location,document)) return
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.plugin = 'dsh-mobile-iroh'; style.textContent = styles; document.head.append(style)
    const remove = ctx.slots.inject('settings.general.item',() => ctx.slots.register({ name:'settings.general.item',id:'dsh-mobile-iroh',order:125 },SettingsAction))
    return () => { remove(); style.remove() }
  },'dsh-mobile-iroh: local operator settings action')
}
