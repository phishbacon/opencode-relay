import type { Config } from "./config.js"
import { serverKey } from "./config.js"

export const notificationHTML = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head>",
  "  <meta charset=\"utf-8\">",
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">",
  "  <meta name=\"theme-color\" content=\"#111111\">",
  "  <title>OpenCode notifications</title>",
  "  <style>",
  "    :root{font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color-scheme:light dark}",
  "    body{max-width:42rem;margin:0 auto;padding:2rem 1rem 4rem;line-height:1.5}",
  "    main{display:grid;gap:1rem}button,input{font:inherit;padding:.75rem;border-radius:.5rem;border:1px solid #777}",
  "    button{cursor:pointer}fieldset{display:grid;gap:.75rem;border:0;padding:0;margin:0}",
  "    #auth[hidden]{display:none}.muted{opacity:.75;font-size:.9rem}.ok{font-weight:600}",
  "  </style>",
  "</head>",
  "<body>",
  "  <main>",
  "    <h1>OpenCode notifications</h1>",
  "    <p id=\"status\">Checking notification support…</p>",
  "    <fieldset id=\"auth\" hidden>",
  "      <label for=\"password\">OpenCode password</label>",
  "      <input id=\"password\" type=\"password\" autocomplete=\"current-password\">",
  "      <button id=\"authenticate\" type=\"button\">Authenticate</button>",
  "      <p class=\"muted\">This is your existing OpenCode password. It is kept only in this page memory and is not stored by the notification service.</p>",
  "    </fieldset>",
  "    <button id=\"enable\" type=\"button\" disabled>Enable notifications</button>",
  "    <button id=\"disable\" type=\"button\" disabled>Disable notifications</button>",
  "    <p class=\"muted\">On iPhone and iPad, Web Push requires the OpenCode site to be installed on the Home Screen.</p>",
  "  </main>",
  "  <script src=\"/notifications/app.js\" defer></script>",
  "</body>",
  "</html>",
].join("\n")

export const notificationAppJS = [
  "\"use strict\";",
  "const statusEl=document.getElementById(\"status\");",
  "const authEl=document.getElementById(\"auth\");",
  "const passwordEl=document.getElementById(\"password\");",
  "const enableEl=document.getElementById(\"enable\");",
  "const disableEl=document.getElementById(\"disable\");",
  "const authenticateEl=document.getElementById(\"authenticate\");",
  "let authorization=\"\";",
  "let settings;",
  "function supported(){return window.isSecureContext&&\"serviceWorker\" in navigator&&\"PushManager\" in window&&\"Notification\" in window}",
  "function basic(password){const bytes=new TextEncoder().encode(\"opencode:\"+password);let value=\"\";for(const byte of bytes)value+=String.fromCharCode(byte);return \"Basic \"+btoa(value)}",
  "async function api(path,options={}){const headers=new Headers(options.headers||{});if(authorization)headers.set(\"authorization\",authorization);if(options.body!==undefined)headers.set(\"content-type\",\"application/json\");const response=await fetch(path,{...options,headers,credentials:\"same-origin\",cache:\"no-store\",body:options.body===undefined?undefined:JSON.stringify(options.body)});if(response.status===401){const error=new Error(\"OpenCode authentication required\");error.code=\"AUTH\";throw error}if(!response.ok){let message=\"HTTP \"+response.status;try{const body=await response.json();if(body&&body.error)message=body.error}catch{}throw new Error(message)}if(response.status===204)return undefined;return response.json()}",
  "function vapidBytes(value){const padding=\"=\".repeat((4-value.length%4)%4);const raw=atob((value+padding).replace(/-/g,\"+\").replace(/_/g,\"/\"));return Uint8Array.from(raw,c=>c.charCodeAt(0))}",
  "function sameKey(current,desired){if(!current)return false;const left=new Uint8Array(current);if(left.length!==desired.length)return false;return left.every((value,index)=>value===desired[index])}",
  "async function registration(){let current=await navigator.serviceWorker.getRegistration(\"/\");if(current)return current;current=await navigator.serviceWorker.register(\"/sw.js\",{scope:\"/\"});await navigator.serviceWorker.ready;return current}",
  "async function currentSubscription(){const current=await navigator.serviceWorker.getRegistration(\"/\");return current?current.pushManager.getSubscription():null}",
  "async function authenticate(silent=false){try{settings=await api(\"/notifications/api/config\");authEl.hidden=true;enableEl.disabled=false;disableEl.disabled=false;return true}catch(error){if(error&&error.code===\"AUTH\"){authEl.hidden=false;enableEl.disabled=true;disableEl.disabled=true;if(!silent)statusEl.textContent=\"Enter your OpenCode password to continue.\";return false}throw error}}",
  "async function refresh(){if(!supported()){statusEl.textContent=\"Web Push is not supported in this browser/context.\";return}const subscription=await currentSubscription();const parts=[\"Permission: \"+Notification.permission,subscription?\"subscription present\":\"no local subscription\"];statusEl.textContent=parts.join(\" · \");await authenticate(true)}",
  "authenticateEl.addEventListener(\"click\",async()=>{try{authorization=basic(passwordEl.value);if(await authenticate(false)){passwordEl.value=\"\";statusEl.textContent=\"Authenticated with OpenCode.\";await refresh()}}catch(error){authorization=\"\";statusEl.textContent=String(error.message||error)}});",
  "enableEl.addEventListener(\"click\",async()=>{try{if(!(await authenticate(false)))return;if(Notification.permission!==\"granted\"){const permission=await Notification.requestPermission();if(permission!==\"granted\")throw new Error(\"Notification permission was not granted\")}const reg=await registration();const desired=vapidBytes(settings.vapidPublicKey);let subscription=await reg.pushManager.getSubscription();if(subscription&&!sameKey(subscription.options.applicationServerKey,desired)){await subscription.unsubscribe();subscription=null}if(!subscription)subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:desired});await api(\"/notifications/api/subscription\",{method:\"PUT\",body:subscription.toJSON()});statusEl.textContent=\"Notifications enabled for this browser.\"}catch(error){statusEl.textContent=String(error.message||error)}await refresh()});",
  "disableEl.addEventListener(\"click\",async()=>{try{if(!(await authenticate(false)))return;const subscription=await currentSubscription();if(subscription){await api(\"/notifications/api/subscription\",{method:\"DELETE\",body:subscription.toJSON()});await subscription.unsubscribe()}statusEl.textContent=\"Notifications disabled for this browser.\"}catch(error){statusEl.textContent=String(error.message||error)}await refresh()});",
  "refresh().catch(error=>{statusEl.textContent=String(error.message||error)});",
].join("\n")

export function serviceWorkerNavigationBypass(): string {
  return [
    "/* opencode-relay:notification-navigation-bypass:v1 */",
    "(()=>{",
    "self.addEventListener(\"fetch\",event=>{",
    "if(event.request.method!==\"GET\"||event.request.mode!==\"navigate\")return;",
    "let url;try{url=new URL(event.request.url)}catch{return}",
    "if(url.origin!==self.location.origin||(url.pathname!==\"/notifications\"&&!url.pathname.startsWith(\"/notifications/\")))return;",
    "event.stopImmediatePropagation();",
    "});",
    "})();",
    "",
  ].join("\n")
}

export function serviceWorkerIntegration(config: Config): string {
  const key = serverKey(config)
  const origin = JSON.stringify(config.publicURL.origin)
  const keyLiteral = JSON.stringify(key)
  return [
    "",
    "/* opencode-relay:notification-integration:v1 */",
    "(()=>{",
    "const EXPECTED_ORIGIN=" + origin + ";",
    "const SERVER_KEY=" + keyLiteral + ";",
    "const SESSION_ROUTE=new RegExp(\"^/server/\"+SERVER_KEY+\"/session/[^/]+$\");",
    "function destination(value){try{const url=new URL(typeof value===\"string\"?value:\"/\",self.location.origin);if(url.origin!==self.location.origin||url.origin!==EXPECTED_ORIGIN||!SESSION_ROUTE.test(url.pathname))return new URL(\"/\",self.location.origin).href;return url.href}catch{return new URL(\"/\",self.location.origin).href}}",
    "self.addEventListener(\"push\",event=>{event.waitUntil((async()=>{let payload={};try{payload=event.data?event.data.json():{}}catch{}const title=payload.title===\"OpenCode failed\"?\"OpenCode failed\":\"OpenCode completed\";await self.registration.showNotification(title,{tag:typeof payload.tag===\"string\"?payload.tag:\"opencode\",data:{url:destination(payload.url)}})})())});",
    "self.addEventListener(\"notificationclick\",event=>{event.notification.close();event.waitUntil((async()=>{const target=destination(event.notification&&event.notification.data&&event.notification.data.url);const windows=await self.clients.matchAll({type:\"window\",includeUncontrolled:true});for(const client of windows){if(client.url===target){await client.focus();return}}for(const client of windows){try{if(new URL(client.url).origin===self.location.origin){const navigated=await client.navigate(target);await (navigated||client).focus();return}}catch{}}await self.clients.openWindow(target)})())});",
    "})();",
    "",
  ].join("\n")
}
