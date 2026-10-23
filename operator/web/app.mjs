const dictionaries = {
  zh: {
    skip:'跳到主内容',language:'语言',localConsole:'独立本机控制台',title:'让手机安全连接这台电脑',subtitle:'配置 DSH 入口、启动传输，然后用手机扫描短期二维码。',lockedTitle:'控制台已锁定',lockedHelp:'请从电脑端重新启动管理界面，使用新的一次性本机链接。不要分享该链接。',transport:'传输状态',start:'启动',stop:'停止',reconnect:'重连',endpoint:'电脑 EndpointId',origin:'手机 HTTPS 地址',stepOne:'第 1 步 · 配置电脑',configTitle:'DSH 授权入口',configHelp:'复制本机 DSH Web 启动时显示的带 token 授权链接。它只留在本进程内存中；重启后需要重新输入。',upstream:'本机授权链接（必填）',upstreamHint:'仅接受 127.0.0.1 或 [::1] 的 HTTP(S) 地址和 token 参数。',show:'显示',hide:'隐藏',port:'手机逻辑端口',localOnly:'仅直连（不使用中继）',save:'保存本次配置',stepTwo:'第 2 步 · 配对手机',pairTitle:'短期配对二维码',pairHelp:'在独立 iroh 手机 App 中扫码。二维码含一次性秘密，请勿截图、转发或放进日志。',qrEmpty:'传输就绪后，点击生成二维码。',hiddenQr:'隐藏或关闭此页面会撤回本页二维码。已复制的内容可能在原到期前仍有效。',pair:'生成二维码',refreshPair:'刷新二维码',copy:'复制配对内容',cancelPairing:'撤回二维码',stepThree:'第 3 步 · 管理连接',peersTitle:'已配对的传输端点',refresh:'刷新',peersHelp:'撤销会移除该 iroh 端点并断开其传输连接；不会替代 DSH Mobile 内的设备令牌撤销。',peersEmpty:'启动后刷新，可查看已配对端点。',noPeers:'还没有已配对端点。请用手机扫描二维码。',tlsTitle:'HTTPS 证书',tlsHelp:'续签使用电脑端证书管理器。证书信任发生变化时，手机可能需要重新配对。',renewTls:'续签证书',localHelp:'管理页只监听本机 127.0.0.1；管理登录与手机配对是两套独立凭据。',logout:'锁定控制台',loading:'正在验证本机管理会话…',confirmTitle:'撤销此传输端点？',confirmDetail:'该端点的 iroh 连接会断开。DSH Mobile 设备凭据不受此操作撤销；如需撤销设备凭据，请另行到 Mobile 管理页操作。',cancel:'取消',forget:'撤销端点',off:'未启动',starting:'正在启动',connecting:'正在连接',ready:'连接就绪',error:'需要处理',stopping:'正在停止',unconfigured:'等待配置',offHelp:'先配置 DSH 入口，再点击启动。停止不会删除电脑身份或配对端点。',readyHelp:'可生成短期二维码配对手机；远程可达性取决于当前网络。',errorHelp:'操作没有确认成功。请检查电脑端配置，然后手动重连；不会自动重放。',busy:'正在处理…',saved:'配置已保存到本次进程。授权链接已从输入框清除。',done:'操作已完成。',operationFailed:'操作未确认成功。请检查本机服务与配置，再手动重试；不要假定已回滚。',invalidUpstream:'请输入带 token 的本机 127.0.0.1 或 [::1] HTTP(S) 授权链接。',invalidPort:'端口必须是 1024 到 65535 的整数。',qrAlt:'一次性手机配对二维码。请勿分享。',expires:'剩余 {seconds} 秒',qrExpired:'二维码已过期并撤回。需要时请重新生成。',copied:'已复制一次性配对内容。请勿分享，使用后清除剪贴板。',copyFailed:'无法访问剪贴板。请使用手机扫码；配对秘密不会显示为普通文本。',online:'在线',offline:'离线',paired:'配对时间',tlsUnknown:'尚未提供证书状态。',tlsMissing:'尚未配置证书',tlsValid:'证书有效',tlsExpiring:'证书即将到期',tlsExpired:'证书已到期',tlsError:'证书管理错误',until:'到期时间：{date}',cancelled:'本页二维码已撤回。已复制的内容可能在原到期前仍有效。',notReady:'请先保存配置并启动传输。',sessionExpired:'管理会话已过期。请在电脑端重新打开控制台。',
  },
  en: {
    skip:'Skip to main content',language:'Language',localConsole:'Independent local console',title:'Connect your phone securely to this computer',subtitle:'Configure the DSH entry, start transport, then scan a short-lived QR code with your phone.',lockedTitle:'Console locked',lockedHelp:'Restart the management interface on this computer to get a fresh one-time local link. Do not share it.',transport:'Transport status',start:'Start',stop:'Stop',reconnect:'Reconnect',endpoint:'Computer EndpointId',origin:'Phone HTTPS address',stepOne:'Step 1 · Configure this computer',configTitle:'DSH authorized entry',configHelp:'Copy the authorized URL with a token shown when local DSH Web starts. It stays only in process memory; enter it again after a restart.',upstream:'Local authorized URL (required)',upstreamHint:'Only HTTP(S) addresses on 127.0.0.1 or [::1] with a token parameter are accepted.',show:'Show',hide:'Hide',port:'Phone logical port',localOnly:'Direct only (no relay)',save:'Save for this run',stepTwo:'Step 2 · Pair your phone',pairTitle:'Short-lived pairing QR',pairHelp:'Scan with the independent iroh phone app. This QR contains one-time secrets. Do not screenshot, forward, or log it.',qrEmpty:'When transport is ready, generate a QR code.',hiddenQr:'Hiding or closing this page withdraws its QR. Previously copied content may remain valid until its original expiry.',pair:'Generate QR',refreshPair:'Refresh QR',copy:'Copy pairing content',cancelPairing:'Withdraw QR',stepThree:'Step 3 · Manage connections',peersTitle:'Paired transport endpoints',refresh:'Refresh',peersHelp:'Revoking removes this iroh endpoint and disconnects its transport. It does not revoke DSH Mobile device tokens.',peersEmpty:'Start transport, then refresh to see paired endpoints.',noPeers:'No paired endpoints yet. Scan the QR code with your phone.',tlsTitle:'HTTPS certificate',tlsHelp:'Renewal uses the computer certificate manager. A change in certificate trust may require pairing the phone again.',renewTls:'Renew certificate',localHelp:'This page listens only on local 127.0.0.1. Operator login and phone pairing use separate credentials.',logout:'Lock console',loading:'Checking the local operator session…',confirmTitle:'Revoke this transport endpoint?',confirmDetail:'This disconnects its iroh transport. DSH Mobile credentials are not revoked; use Mobile device management separately to revoke them.',cancel:'Cancel',forget:'Revoke endpoint',off:'Stopped',starting:'Starting',connecting:'Connecting',ready:'Ready to connect',error:'Action required',stopping:'Stopping',unconfigured:'Configuration needed',offHelp:'Configure the DSH entry, then start. Stopping preserves computer identity and paired endpoints.',readyHelp:'Generate a short-lived QR to pair your phone. Remote reachability depends on the current network.',errorHelp:'The operation was not confirmed. Check local configuration, then reconnect manually. It is not replayed automatically.',busy:'Working…',saved:'Configuration saved for this process. The authorized URL was cleared from the form.',done:'Operation completed.',operationFailed:'The outcome was not confirmed. Check the local service and configuration, then retry manually. Do not assume rollback.',invalidUpstream:'Enter an HTTP(S) authorized URL on 127.0.0.1 or [::1] with a token.',invalidPort:'Enter an integer port from 1024 to 65535.',qrAlt:'One-time phone pairing QR. Do not share.',expires:'Expires in {seconds}s',qrExpired:'The QR expired and was withdrawn. Generate a new one when needed.',copied:'One-time pairing content copied. Do not share it; clear the clipboard after use.',copyFailed:'Clipboard access failed. Scan with your phone; pairing secrets will not be displayed as ordinary text.',online:'Online',offline:'Offline',paired:'Paired',tlsUnknown:'Certificate status is not available yet.',tlsMissing:'Certificate not configured',tlsValid:'Certificate valid',tlsExpiring:'Certificate expires soon',tlsExpired:'Certificate expired',tlsError:'Certificate manager error',until:'Expires: {date}',cancelled:'The QR was withdrawn from this page. Previously copied content may remain valid until its original expiry.',notReady:'Save configuration and start transport first.',sessionExpired:'Your operator session expired. Open the console again on this computer.',
  },
  it: {
    skip:'Vai al contenuto',language:'Lingua',localConsole:'Console locale indipendente',title:'Collega il telefono a questo computer in sicurezza',subtitle:'Configura DSH, avvia il trasporto e scansiona un codice QR temporaneo con il telefono.',lockedTitle:'Console bloccata',lockedHelp:'Riavvia l’interfaccia di gestione sul computer per ottenere un nuovo link locale monouso. Non condividerlo.',transport:'Stato del trasporto',start:'Avvia',stop:'Arresta',reconnect:'Riconnetti',endpoint:'EndpointId del computer',origin:'Indirizzo HTTPS del telefono',stepOne:'Passo 1 · Configura il computer',configTitle:'Accesso autorizzato a DSH',configHelp:'Copia l’URL con token mostrato all’avvio di DSH Web locale. Rimane solo nella memoria del processo; inseriscilo di nuovo dopo il riavvio.',upstream:'URL locale autorizzato (obbligatorio)',upstreamHint:'Sono accettati solo indirizzi HTTP(S) su 127.0.0.1 o [::1] con parametro token.',show:'Mostra',hide:'Nascondi',port:'Porta logica del telefono',localOnly:'Solo diretto (senza relay)',save:'Salva per questa esecuzione',stepTwo:'Passo 2 · Associa il telefono',pairTitle:'QR di associazione temporaneo',pairHelp:'Scansiona con l’app iroh indipendente. Il QR contiene segreti monouso: non acquisirlo, inoltrarlo o registrarlo nei log.',qrEmpty:'Quando il trasporto è pronto, genera un codice QR.',hiddenQr:'Nascondendo o chiudendo la pagina, il QR viene rimosso. Il contenuto già copiato potrebbe restare valido fino alla scadenza originale.',pair:'Genera QR',refreshPair:'Aggiorna QR',copy:'Copia contenuto di associazione',cancelPairing:'Rimuovi QR',stepThree:'Passo 3 · Gestisci le connessioni',peersTitle:'Endpoint di trasporto associati',refresh:'Aggiorna',peersHelp:'La revoca rimuove l’endpoint iroh e interrompe il trasporto. Non revoca i token dei dispositivi DSH Mobile.',peersEmpty:'Avvia il trasporto e aggiorna per vedere gli endpoint.',noPeers:'Nessun endpoint associato. Scansiona il QR con il telefono.',tlsTitle:'Certificato HTTPS',tlsHelp:'Il rinnovo usa il gestore certificati del computer. Una modifica della fiducia del certificato può richiedere una nuova associazione.',renewTls:'Rinnova certificato',localHelp:'La pagina ascolta solo su 127.0.0.1 locale. Accesso operatore e associazione del telefono usano credenziali separate.',logout:'Blocca console',loading:'Verifica della sessione operatore locale…',confirmTitle:'Revocare questo endpoint di trasporto?',confirmDetail:'Il trasporto iroh verrà disconnesso. Le credenziali DSH Mobile non vengono revocate; per farlo usa separatamente la gestione dispositivi Mobile.',cancel:'Annulla',forget:'Revoca endpoint',off:'Arrestato',starting:'Avvio in corso',connecting:'Connessione in corso',ready:'Pronto per la connessione',error:'Intervento richiesto',stopping:'Arresto in corso',unconfigured:'Configurazione necessaria',offHelp:'Configura l’accesso a DSH, poi avvia. L’arresto conserva l’identità del computer e gli endpoint associati.',readyHelp:'Genera un QR temporaneo per associare il telefono. La raggiungibilità remota dipende dalla rete attuale.',errorHelp:'L’operazione non è stata confermata. Controlla la configurazione locale e riconnetti manualmente. Non viene ripetuta automaticamente.',busy:'Operazione in corso…',saved:'Configurazione salvata per il processo. L’URL autorizzato è stato cancellato dal modulo.',done:'Operazione completata.',operationFailed:'Esito non confermato. Controlla servizio e configurazione locali, poi riprova manualmente. Non presumere un ripristino.',invalidUpstream:'Inserisci un URL HTTP(S) autorizzato su 127.0.0.1 o [::1] con un token.',invalidPort:'Inserisci una porta intera da 1024 a 65535.',qrAlt:'QR monouso per associare il telefono. Non condividere.',expires:'Scade tra {seconds}s',qrExpired:'Il QR è scaduto ed è stato rimosso. Generane uno nuovo se necessario.',copied:'Contenuto monouso copiato. Non condividerlo e cancella gli appunti dopo l’uso.',copyFailed:'Accesso agli appunti non riuscito. Scansiona con il telefono; i segreti non saranno mostrati come testo.',online:'Online',offline:'Offline',paired:'Associato',tlsUnknown:'Stato del certificato non ancora disponibile.',tlsMissing:'Certificato non configurato',tlsValid:'Certificato valido',tlsExpiring:'Certificato in scadenza',tlsExpired:'Certificato scaduto',tlsError:'Errore del gestore certificati',until:'Scadenza: {date}',cancelled:'Il QR è stato rimosso dalla pagina. Il contenuto già copiato potrebbe restare valido fino alla scadenza originale.',notReady:'Salva la configurazione e avvia prima il trasporto.',sessionExpired:'Sessione operatore scaduta. Riapri la console sul computer.',
  },
}
const $ = (id) => document.getElementById(id)
Object.assign(dictionaries.zh,{ managedHelp:'已连接当前 DSH，无需复制授权链接。默认设置可直接启动；如需更改端口，请先停止传输。',managedSaved:'连接设置已保存，仍使用当前 DSH。',managedOff:'当前 DSH 已自动授权，点击启动即可连接手机。停止不会删除身份或配对。' })
Object.assign(dictionaries.en,{ managedHelp:'Connected to the current DSH; no authorized URL is needed. Start with the defaults, or stop transport before changing its port.',managedSaved:'Connection settings saved for the current DSH.',managedOff:'The current DSH is authorized. Start to connect your phone. Stopping preserves identity and pairings.' })
Object.assign(dictionaries.it,{ managedHelp:'Collegato al DSH attuale; non serve copiare un URL autorizzato. Avvia con i valori predefiniti o arresta il trasporto prima di cambiare porta.',managedSaved:'Impostazioni salvate per il DSH attuale.',managedOff:'Il DSH attuale è autorizzato. Avvia per collegare il telefono. L’arresto conserva identità e associazioni.' })
Object.assign(dictionaries.zh,{ configRunning:'更改入口或端口前请先停止传输，以免中断已有手机连接。' })
Object.assign(dictionaries.en,{ configRunning:'Stop transport before changing the entry or port, so existing phone connections are not interrupted unexpectedly.' })
Object.assign(dictionaries.it,{ configRunning:'Arresta il trasporto prima di cambiare accesso o porta, per non interrompere inaspettatamente i telefoni connessi.' })
Object.assign(dictionaries.zh,{ tlsMissing:'本次进程尚未加载证书状态' })
Object.assign(dictionaries.en,{ tlsMissing:'Certificate status is not loaded in this process' })
Object.assign(dictionaries.it,{ tlsMissing:'Stato del certificato non caricato in questo processo' })
Object.assign(dictionaries.zh,{ controlErrorHelp:'手机传输仍在运行，但管理查询未确认完成。请手动重连后再配对或管理端点；不会自动重放。' })
Object.assign(dictionaries.en,{ controlErrorHelp:'Phone transport remains active, but a management query was not confirmed. Reconnect manually before pairing or managing peers; no action is replayed automatically.' })
Object.assign(dictionaries.it,{ controlErrorHelp:'Il trasporto resta attivo, ma una richiesta di gestione non è stata confermata. Riconnetti manualmente prima di associare o gestire endpoint; nessuna azione viene ripetuta automaticamente.' })
Object.assign(dictionaries.zh,{ localOnly:'仅本机测试（无公共发现/中继）' })
Object.assign(dictionaries.en,{ localOnly:'Local testing only (no public discovery/relay)' })
Object.assign(dictionaries.it,{ localOnly:'Solo test locali (senza discovery pubblica/relay)' })
let language = navigator.language.startsWith('zh') ? 'zh' : navigator.language.startsWith('it') ? 'it' : 'en'
let csrf
let authenticated = false
let busy = false
let status
let peers
let expiresAt
let qrRequest
let qrGeneration = 0
let sessionExpires = 0
let lastFocused
let selectedPeer
const t = (key, values = {}) => Object.entries(values).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), dictionaries[language][key] ?? key)
const locale = () => ({ zh:'zh-CN', en:'en', it:'it' })[language]
const date = (time) => new Date(time).toLocaleString(locale())
function message(key, error = false) { $('notice').textContent = t(key); $('notice').classList.toggle('error', error); $('notice').hidden = false }
function clearUpstream() { $('upstream').value = ''; $('upstream').type = 'password'; $('showUpstream').setAttribute('aria-pressed','false'); $('showUpstream').textContent = t('show') }
function lock() {
  authenticated = false; csrf = undefined; clearQr(false); clearUpstream(); $('workspace').hidden = true; $('locked').hidden = false
}
function translate() {
  document.documentElement.lang = locale(); $('language').value = language
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n) })
  $('showUpstream').textContent = t($('upstream').type === 'password' ? 'show' : 'hide')
  $('qr').alt = t('qrAlt'); render(); renderPeers(); countdown()
}
async function api(route, body = { version:1 }, options = {}) {
  let response
  try {
    response = await fetch(`/api/v1/${route}`, { method:'POST', credentials:'same-origin', cache:'no-store', headers:{ 'Content-Type':'application/json', ...(csrf ? { 'X-Operator-CSRF':csrf } : {}) }, body:JSON.stringify(body), ...options })
  } catch (error) { if (error.name === 'AbortError') throw error; throw new Error('operationFailed') }
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401) { lock(); throw new Error('sessionExpired') }
    throw new Error(result.error === 'operator_pairing_expired' ? 'qrExpired' : 'operationFailed')
  }
  if (result.version !== 1) throw new Error('operationFailed')
  return result
}
function render() {
  if (!status) return
  $('statusTitle').textContent = t(status.state)
  $('statusDetail').textContent = t(status.controlErrorCode ? 'controlErrorHelp' : status.state === 'ready' ? 'readyHelp' : status.state === 'error' ? 'errorHelp' : 'offHelp')
  const managed = status.managedHost === true
  $('upstreamFields').hidden = managed; $('upstream').required = !managed; $('upstream').disabled = managed
  $('configHelp').textContent = t(managed ? 'managedHelp' : 'configHelp')
  if (managed && status.state === 'off') $('statusDetail').textContent = t('managedOff')
  $('identity').hidden = !status.endpointId
  $('endpoint').textContent = status.endpointId ?? '—'; $('origin').textContent = status.origin ?? '—'
  const ready = status.state === 'ready'
  for (const id of ['start','reconnect','save','renewTls','refreshPeers','pair','copy','logout']) $(id).disabled = busy
  $('start').disabled ||= ready || status.configured === false
  $('save').disabled ||= ready || ['starting','connecting','stopping'].includes(status.state)
  $('configRunning').hidden = !ready && !['starting','connecting','stopping'].includes(status.state)
  $('reconnect').disabled ||= status.configured === false
  $('stop').disabled = !busy && (status.state === 'off' || status.state === 'unconfigured')
  $('pair').disabled ||= !ready || !!status.controlErrorCode; $('refreshPeers').disabled ||= !ready || !!status.controlErrorCode
  $('pair').textContent = t(expiresAt ? 'refreshPair' : 'pair')
  $('renewTls').disabled ||= status.tls?.renewable !== true
  let tls = t('tlsUnknown')
  if (status.tls) {
    tls = t(`tls${status.tls.state[0].toUpperCase()}${status.tls.state.slice(1)}`)
    if (status.tls.notAfter) tls += ` · ${t('until', { date:date(status.tls.notAfter) })}`
  }
  $('tlsStatus').textContent = tls
}
function renderPeers() {
  if (!peers) return
  $('peers').replaceChildren()
  $('peersEmpty').hidden = peers.length > 0; $('peersEmpty').textContent = t('noPeers')
  for (const peer of peers) {
    const row = document.createElement('li'); row.className = 'peer'
    const content = document.createElement('div')
    const name = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = peer.name; name.append(strong)
    const id = document.createElement('p'); id.className = 'mono'; id.textContent = peer.id
    const pairedTime = Number(peer.paired_at.slice(5)) * 1000
    const detail = document.createElement('small'); detail.textContent = `${t(peer.online ? 'online' : 'offline')} · ${t('paired')}: ${Number.isSafeInteger(pairedTime) && pairedTime <= 8.64e15 ? date(pairedTime) : peer.paired_at}`
    content.append(name,id,detail)
    const button = document.createElement('button'); button.textContent = t('forget'); button.className = 'danger'; button.disabled = busy || !!status?.controlErrorCode
    button.addEventListener('click', () => { selectedPeer = peer; lastFocused = button; $('confirmPeer').textContent = `${peer.name}\n${peer.id}`; $('confirmation').showModal(); $('confirmCancel').focus() })
    row.append(content,button); $('peers').append(row)
  }
}
async function refresh() { const result = await api('status'); status = result.status; render() }
async function action(operation, success = 'done') {
  if (busy) return
  busy = true; render(); renderPeers(); message('busy')
  try { await operation(); if (authenticated) { await refresh(); message(success) } }
  catch (error) { if (error.name !== 'AbortError') message(error.message in dictionaries[language] ? error.message : 'operationFailed', true) }
  finally { busy = false; render(); renderPeers() }
}
function clearQr(cancel = true) {
  qrGeneration += 1; qrRequest?.abort(); qrRequest = undefined; expiresAt = undefined
  $('qr').removeAttribute('src'); $('qrPanel').hidden = true; $('qrEmpty').hidden = false; $('copy').hidden = true; $('cancelPairing').hidden = true; $('countdown').textContent = ''
  if (cancel && authenticated) void api('pairing/cancel', { version:1 }, { keepalive:true }).catch(() => {})
  render()
}
function countdown() {
  if (!expiresAt) return
  const remaining = Math.ceil((expiresAt - Date.now()) / 1000)
  if (remaining <= 0) { clearQr(); message('qrExpired'); return }
  $('countdown').textContent = t('expires', { seconds:remaining })
}
$('configuration').addEventListener('submit', (event) => {
  event.preventDefault()
  let validUrl = false
  const upstreamAuthenticatedUrl = $('upstream').value.trim()
  try { const url = new URL(upstreamAuthenticatedUrl); validUrl = ['http:','https:'].includes(url.protocol) && ['127.0.0.1','[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash && !!url.searchParams.get('token') } catch { /* The inline validation message owns malformed URLs. */ }
  if (status?.managedHost === true) validUrl = true
  const localPort = Number($('port').value)
  const validPort = Number.isInteger(localPort) && localPort >= 1024 && localPort <= 65535
  for (const [id, valid, key] of [['upstream',validUrl,'invalidUpstream'],['port',validPort,'invalidPort']]) {
    $(id).setAttribute('aria-invalid', String(!valid)); $(`${id}Error`).hidden = valid; $(`${id}Error`).textContent = valid ? '' : t(key)
  }
  if (!validUrl || !validPort) { $(validUrl ? 'port' : 'upstream').focus(); return }
  clearQr()
  void action(async () => { try { const result = await api('configure', { version:1, ...(status?.managedHost === true ? {} : { upstreamAuthenticatedUrl }), localPort, localOnly:$('localOnly').checked }); status = result.status } finally { clearUpstream() } }, status?.managedHost === true ? 'managedSaved' : 'saved')
})
$('showUpstream').addEventListener('click', () => { const show = $('upstream').type === 'password'; $('upstream').type = show ? 'text' : 'password'; $('showUpstream').textContent = t(show ? 'hide' : 'show'); $('showUpstream').setAttribute('aria-pressed',String(show)) })
for (const route of ['start','reconnect']) $(route).addEventListener('click', () => { clearQr(); void action(async () => { await api(route) }) })
$('stop').addEventListener('click', () => {
  clearQr(); message('busy')
  // Stop is deliberately available while a pairing request is pending.
  void api('stop').then((result) => { status = result.status; render(); message('done') }).catch((error) => message(error.message, true))
})
$('pair').addEventListener('click', () => {
  clearQr(false)
  const generation = qrGeneration
  void action(async () => {
    qrRequest = new AbortController()
    const result = await api('pairing', { version:1 }, { signal:qrRequest.signal })
    if (generation !== qrGeneration || document.hidden || !authenticated) return
    expiresAt = result.expiresAt
    if (expiresAt <= Date.now()) throw new Error('qrExpired')
    $('qr').src = result.qrImage; $('qrPanel').hidden = false; $('qrEmpty').hidden = true; $('copy').hidden = false; $('cancelPairing').hidden = false; countdown()
  })
})
$('cancelPairing').addEventListener('click', () => { clearQr(); message('cancelled') })
$('copy').addEventListener('click', () => { void action(async () => {
  const result = await api('pairing/copy')
  if (document.hidden || !expiresAt || Date.now() >= result.expiresAt) { clearQr(); throw new Error('qrExpired') }
  try { await navigator.clipboard.writeText(result.payload) } catch { throw new Error('copyFailed') }
}, 'copied') })
$('refreshPeers').addEventListener('click', () => { void action(async () => { peers = (await api('peers')).peers; renderPeers() }) })
$('renewTls').addEventListener('click', () => { clearQr(); void action(async () => { await api('tls/renew') }) })
$('confirmation').addEventListener('close', () => {
  const peer = selectedPeer; selectedPeer = undefined
  if ($('confirmation').returnValue === 'forget' && peer) void action(async () => { peers = (await api('peers/forget', { version:1, id:peer.id })).peers; $('refreshPeers').focus() })
  lastFocused?.focus()
})
$('logout').addEventListener('click', () => { void action(async () => { clearQr(); await api('logout'); lock() }) })
$('language').addEventListener('change', () => { language = $('language').value; translate() })
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearQr(); clearUpstream() } else if (authenticated && !busy) void refresh().catch(() => message('operationFailed',true)) })
window.addEventListener('pagehide', () => { clearQr(); clearUpstream() })
setInterval(() => { countdown(); if (authenticated && Date.now() >= sessionExpires) { clearQr(); lock(); message('sessionExpired',true) } },250)
setInterval(() => { if (authenticated && !busy && !document.hidden) void refresh().catch((error) => message(error.message,true)) },5000)
translate()
let token = location.hash.slice(1)
history.replaceState(null,'',location.pathname)
try {
  const session = await api('session', token ? { version:1, token } : { version:1 })
  csrf = session.csrf; sessionExpires = session.expiresAt; authenticated = true
  await refresh(); $('workspace').hidden = false
  if (status.localPort) $('port').value = status.localPort
  if (typeof status.localOnly === 'boolean') $('localOnly').checked = status.localOnly
} catch (error) { lock(); message(error.message in dictionaries[language] ? error.message : 'operationFailed',true) }
finally { token = undefined; $('loading').hidden = true }
