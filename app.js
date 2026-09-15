import { answerQueue } from './answer-queue.mjs';
import { MINUTE_FIELDS, minuteValue, carBaseline, carBaselineSummary, confirmedProfile } from "./journey-profile.mjs";
// Reisevalg PWA. Vanilla JS, no build step. Screens: onboarding → home → settings.
const CFG = window.REISEVALG_CONFIG;
// The API host may move (tunnel rotation, later Supabase). Order: the last base that worked on this device,
// then config.js, then the discovery file. A base is kept only after /config answered.
// A relative apiBase ("/api") means the page and the API are the same service, which cannot move and cannot be
// blocked by a network. Any address remembered from the old tunnel is then wrong, and is forgotten here — that
// is what carries an already-installed app over to the hosted version without anyone reinstalling anything.
const SAME_ORIGIN_API = CFG.apiBase.startsWith("/");
let API = (() => {
  if (SAME_ORIGIN_API) { try { localStorage.removeItem("apiBase"); } catch {} return CFG.apiBase.replace(/\/$/, ""); }
  try { const s = localStorage.getItem("apiBase"); if (s && /^https?:\/\//.test(s)) return s.replace(/\/$/, ""); } catch {}
  return CFG.apiBase.replace(/\/$/, "");
})();
async function discoverApi() {
  if (SAME_ORIGIN_API) return false;    // nothing to discover: the API is wherever this page came from
  const candidates = [CFG.apiBase.replace(/\/$/, "")];
  if (CFG.apiDiscoveryUrl) { try { const r = await fetch(CFG.apiDiscoveryUrl + (CFG.apiDiscoveryUrl.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(8000) }); const j = await r.json(); if (j.apiBase && /^https:\/\//.test(j.apiBase)) candidates.unshift(j.apiBase.replace(/\/$/, "")); } catch {} }
  for (const base of candidates) {
    if (base === API) continue;
    try { const r = await fetch(base + "/config", { headers: { "Bypass-Tunnel-Reminder": "true" }, signal: AbortSignal.timeout(8000) }); if (r.ok) { API = base; try { localStorage.setItem("apiBase", base); } catch {} if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?api=" + encodeURIComponent(new URL(API, location.href).href), { updateViaCache: "none" }).catch(() => {}); return true; } } catch {}
  }
  return false;
}
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const state = { profile: null, config: null, verdicts: [], latest: null, pushSupported: "serviceWorker" in navigator && "PushManager" in window, step: 0 };

const HELP = {
  dekning: ["Hvilke strekninger", "Vi trenger målt kjøretid fra Statens vegvesen for hele veien bilen kjører inn til Oslo. Det finnes for E18 vest fra Sandvika og innover, for E6 sør fra Moss og innover, for E18 Mosseveien fra Fiskevollbukta og innover, og for E6 nord fra Jessheim, pluss Rv159 fra Lillestrøm. Vest for Holmen (Asker, Lier, Brakerøya) publiserer Vegvesenet ikke tall ennå. Lysaker/Fornebu mangler en målt avkjøring. Ønsk deg en strekning, så prioriterer vi etter etterspørsel."],
  installer: ["Slik får du varsler", "<b>iPhone:</b> åpne lenken i Safari, trykk Del-knappen (firkanten med pil opp), velg «Legg til på Hjem-skjerm», og åpne appen derfra. Bare da kan iPhone vise varsler fra en nettapp.<br><br><b>Android:</b> trykk menyen (⋮) i Chrome og «Legg til på startskjermen» eller «Installer app». Varsler virker også uten, men er sikrest med appen installert.<br><br>Til slutt trykker du «Lagre og slå på varsler» og godtar spørsmålet fra telefonen."],
  avreise: ["Når drar du?", "Kortet kommer 06:30 og 07:00, men regner for tidspunktet du faktisk drar. Drar du 07:30, sier kortet hva vi venter av kø på veien da, ut fra køen nå, hvordan den utvikler seg, og hva som er vanlig på denne veien på dette tidspunktet. Uten svar regner vi med at du drar ti minutter etter kortet."],
  togreise: ["Togreisen", "Vi trenger to tider fra deg: hjemmefra til du står klar på perrongen (med kjøring, sykkel, parkering og gange), og fra stasjonen du kommer til og helt frem til jobb. Ventetid og selve togturen regner vi ut fra rutetabell og sanntid."],
  toStationMin: ["Hjem til perrongen", "Fra du går hjemmefra til du står klar til å gå om bord. Ta med eventuell kjøring eller sykling, parkering og gange. Ikke ta med venting på toget."],
  walkFromStationMin: ["Fra stasjonen til jobb", "Fra du går av toget til du er fremme på jobb, inkludert veien ut av stasjonen."],
  bilreise: ["Bilen", "Vi sammenligner med bil på samme strekning, hjemmefra og helt til jobb. Du trenger ikke kjøre bil til vanlig. Kjøretiden uten kø oppgir du selv; køen henter vi fra Statens vegvesen hver morgen."],
  carFreeFlowMin: ["Kjøretid uten kø", "Bare kjøringen, hjemmefra til der du ville parkert ved jobb, en dag helt uten kø. Parkering og gange kommer i neste felt."],
  parkingWalkMin: ["Parkering og gange", "Tiden fra du stopper bilen til du sitter på jobb: finne plass, parkere, gå. Skriv 0 hvis det ikke tar tid."],
  bil: ["Bil i dag", "Kjøretiden uten kø du oppga + modellert køtillegg + parkering og gange til jobb. Dine egne tider er anslag. DATEX beskriver veistrekninger, ikke en observert personlig biltur."],
  tog: ["Tog i dag", "Tiden du bruker til stasjonen, ventetid til neste tog etter at du rekker fram, togets kjøretid med sanntid fra Entur, og gangen fra stasjonen til jobb."],
  sparer: ["Du sparer", "Bil i dag minus tog i dag. Vi sier bare at toget vinner når differansen er minst 10 minutter og togene i ditt tidsvindu ikke har varsler i Avviksvarsel. Hvis køen er i ferd med å løse seg opp krever vi 15."],
  kø: ["Køen på veien din", "Summen av målt reisetid minus fri flyt på strekningene Statens vegvesen dekker inn mot Oslo, på den veien du faktisk ville kjørt: E18 vest, E6 nord, E6 sør eller Mosseveien. Finnes det en reell omvei, regner vi begge og bruker den raskeste den morgenen. Trenden sier om køen øker, er stabil eller avtar. Vest for Holmen måler Vegvesenet ingenting, så for Lier, Brakerøya og Asker ser vi bare de siste 16 kilometerne. Resten regnes som helt uten kø. Det gjør anslaget forsiktig, ikke feil: er det kø der også, sparer toget mer enn vi sier."],
  togstatus: ["Togene i dag", "Avviksvarsel omfatter reisene tjenesten dekker. Tom varslingsliste er ingen garanti for normal trafikk. Journey Planner viser forventede tider, ikke dokumentasjon på faktisk ankomst."],
  tilstand: ["Hva kortet kan si", "«I dag vinner toget» er det eneste varselet vi sender, og bare når køen avgjør. Slår bilen toget, får du ingen melding. Åpner du appen, ser du likevel dagens regnestykke: «ingen togfordel», «toget er raskest uansett» (der toget slår bilen selv uten kø), «togene er usikre» eller «vet ikke». Vi sier aldri «ta bilen»."],
  test: ["Testperiode", "Du er med i en test med kolleger. Varsel kommer bare de morgenene toget vinner; de andre morgenene er det stille. Alt du svarer på kortet brukes til å måle om varselet treffer. Vi lagrer ingen adresse, bare stasjon, arbeidsområde og minuttene du oppgir."],
  fasit: ["Stemte det?", "Når kjøreturen din er over, henter vi køen Vegvesenet målte på veien din mens du kjørte, og regner ut hvem som vant. Svaret står på kortet, også når vi tok feil. Varslet vi ikke, og toget vant likevel, sier vi det. Togtiden er sanntidsprognosen fra da kortet ble laget, ikke en målt ankomst. Bilturen er regnet ut fra veidata og tidene du oppga, ikke en biltur noen har kjørt."],
  ferskhet: ["Kilder og ferskhet", "Veidata: Statens vegvesen DATEX II, oppdatert hvert femte minutt. Tog: Entur Avviksvarsel og Journey Planner med sanntid. Kortet lages klokka 06:30 og 07:00 og bruker målingene som var ferske da."],
};

// ---------- utilities ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const deviceId = store.get("deviceId") || (() => { const id = uid(); store.set("deviceId", id); return id; })();
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
// What we know about this device, without anything personal. Explains delivery problems and shows who is testing.
function clientFacts() {
  const ua = navigator.userAgent;
  const platform = /iphone|ipad|ipod/i.test(ua) ? "ios" : /android/i.test(ua) ? "android" : /macintosh/i.test(ua) ? "mac" : /windows/i.test(ua) ? "windows" : "annet";
  const browser = /CriOS|Chrome/.test(ua) ? "chrome" : /Safari/.test(ua) ? "safari" : /Firefox|FxiOS/.test(ua) ? "firefox" : "annet";
  return { platform, standalone: String(window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true), permission: ("Notification" in window) ? Notification.permission : "n/a", lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: `${screen.width}x${screen.height}`, ua: browser + " " + (ua.match(/(?:Version|CriOS|Chrome|Firefox)\/(\d+)/)?.[1] || ""), appVersion: CFG.appVersion || "dev" };
}
function track(kind, meta) { try { fetch(API + "/events", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true" }, body: JSON.stringify({ deviceId, kind, meta: meta || {}, client: clientFacts() }) }).catch(() => {}); } catch {} }
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const hhmm = (iso) => new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
// Norwegian writes 14,7 — not 14.7. String() gives the English form, which reads as a typo in a Norwegian app.
const fmtMin = n => Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString("nb-NO") : "–";
const dateLabel = (iso) => new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }
function help(key) { const [title, body] = HELP[key] || ["", ""]; $("#popover-title").textContent = title; $("#popover-body").innerHTML = `<p>${body}</p>`; $("#popover").hidden = false; $("#popover-close").focus(); }
$("#popover-close").addEventListener("click", () => ($("#popover").hidden = true));
$("#popover").addEventListener("click", (e) => { if (e.target.id === "popover") $("#popover").hidden = true; });
document.addEventListener("click", (e) => { const q = e.target.closest("[data-help]"); if (q) help(q.dataset.help); });
const Q = (key) => `<button class="q" type="button" data-help="${key}" aria-label="Forklaring">?</button>`;

async function api(path, opts = {}) {
  // Bypass-Tunnel-Reminder: the API may sit behind localtunnel, which otherwise answers browsers with a reminder page.
  let res;
  try { res = await fetch(API + path, { signal:AbortSignal.timeout(12000), headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "true", ...(opts.headers || {}) }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
  catch (e) { if (!opts._retried && await discoverApi()) return api(path, { ...opts, _retried: true }); throw e; }
  if ((res.status === 408 || res.status === 502 || res.status === 503 || res.status === 504) && !opts._retried && await discoverApi()) return api(path, { ...opts, _retried: true });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${await res.text().catch(() => "")}`),{status:res.status});
  return res.status === 204 ? null : res.json();
}
const answers=answerQueue(localStorage,(path,body)=>api(path,{method:'POST',body,signal:AbortSignal.timeout(15000)}),(item,receipt)=>{
 if(item.path==='/subscriptions'){
  const profile={...item.body.profile,pushEnabled:receipt.pushEnabled,storageReceipt:receipt};
  localStorage.setItem('profile',JSON.stringify(profile));state.profile=profile;store.del('onboardingDraft');
 }
},fn=>{if(!navigator.locks)throw Error('Nettleseren mangler trygg sendekø. Oppdater nettleseren.');return navigator.locks.request('reisevalg-answers',fn);},()=>location.reload());
async function retryAnswers(){try{await answers.flush();render();}catch{toast('Svar venter på bekreftet lagring. Hold appen åpen med nett og prøv igjen.',6000);}}

// The API lives behind a tunnel whose address changes when the tunnel restarts. A save that fell in that gap
// stays in the queue; send it again as soon as the device is back online, the app is looked at, or a minute
// has passed, rediscovering the address first. Nothing is lost, and the user does not have to press anything.
let autoRetryAt = 0;
async function autoRetryAnswers(reason) {
  if (!answers.pending() || Date.now() < autoRetryAt) return;
  autoRetryAt = Date.now() + 20000;
  try { await discoverApi(); } catch {}
  try { await answers.flush(); track("save_retry_ok", { reason }); toast("Reisen er lagret."); render(); } catch {}
}
addEventListener("online", () => autoRetryAnswers("online"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) autoRetryAnswers("visible"); });
setInterval(() => autoRetryAnswers("timer"), 60000);
window.addEventListener('online',retryAnswers);
setTimeout(retryAnswers,1000);
function urlBase64ToUint8Array(s) { const pad = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }

// ---------- rendering ----------
function render() {
  $("#btn-settings").hidden = !state.profile;
  if (!state.profile) return renderOnboarding();
  renderHome();
}

function renderOnboarding() {
  const d = state.draft || (state.draft = store.get("onboardingDraft") || { station: "", workArea: "", toStationMin: null, walkFromStationMin: null, carFreeFlowMin: null, parkingWalkMin: null, leaveAt: null, slots: ["06:30", "07:00"], days: [0, 1, 2, 3, 4] });
  const stations = state.config?.stations || {};
  const areas = state.config?.workAreas || {};
  const st = stations[d.station] || {};
  const available = Object.keys(stations).length && Object.keys(areas).length;
  const area = areas[d.workArea] || {};
  const suggestions = {
    walkFromStationMin: area.walkMin != null ? { value: area.walkMin, why: `typisk gange fra ${(area.label || "").split(" / ")[0]}` } : null,
    carFreeFlowMin: st.carFreeFlowMin != null ? { value: st.carFreeFlowMin + (Number.isFinite(d.toStationMin) ? d.toStationMin : 5), why: `${st.carFreeFlowMin} min fra ${st.name} til Oslo S uten kø + ${Number.isFinite(d.toStationMin) ? d.toStationMin : 5} min hjemmefra` } : null,
    parkingWalkMin: { value: 8, why: "typisk parkering og gange i sentrum" },
  };
  const suggest = (key) => { const s = suggestions[key]; return s && !Number.isFinite(d[key]) && !d.unknownFields?.includes(key) ? `<div class="chips" style="margin-top:.35rem"><button type="button" class="chip" data-suggest="${key}" data-v="${s.value}">Bruk forslag: ${s.value} min</button><span class="hint">${s.why}. Juster hvis du vet bedre.</span></div>` : ""; };
  const minutes = (key, hint) => `<div class="field"><label for="f-${key}">${MINUTE_FIELDS[key].label} ${Q(key)}</label><div class="minute-input"><input id="f-${key}" data-minutes="${key}" type="number" inputmode="numeric" enterkeyhint="done" min="0" max="${MINUTE_FIELDS[key].max}" step="1" ${d.unknownFields?.includes(key) ? "disabled" : "required"} value="${Number.isFinite(d[key]) ? d[key] : ""}" aria-describedby="hint-${key}"><span aria-hidden="true">min</span><button type="button" class="chip done" data-done>Ferdig</button></div><span class="hint" id="hint-${key}">${hint}</span>${suggest(key)}<label class="confirm-times hint"><input type="checkbox" data-unknown="${key}" ${d.unknownFields?.includes(key) ? "checked" : ""}>Vet ikke ennå</label></div>`;
  const sum = carBaseline(d);
  const installHint = isStandalone ? "" : isIOS
    ? `<div class="ios-hint"><b>Først: legg appen på Hjem-skjermen.</b> Del-knappen → «Legg til på Hjem-skjerm» → åpne den derfra. Ellers kan iPhone ikke vise varsler. ${Q("installer")}</div>`
    : `<p class="small muted">Tips: installer appen fra nettlesermenyen for sikre varsler. ${Q("installer")}</p>`;
  const steps = [
    () => `
      <h1>Får du beskjed når toget slår bilen?</h1>
      <p>Hver hverdag kl. 06:30 og 07:00 regner vi bil mot tog for din reise. Du får varsel bare når toget vinner. ${Q("tilstand")}</p>
      ${installHint}
      <p class="small"><b>Gjelder nå:</b> E18 vest fra Sandvika, Slependen og Høvik. E6 sør fra Ski, Ås, Langhus, Vevelstad, Oppegård, Vestby og Moss. E18 Mosseveien fra Kolbotn og Holmlia. E6 nord og Rv159 fra Jessheim, Kløfta og Lillestrøm. Inn til Oslo S, sentrum vest og Skøyen. Asker, Lier og Brakerøya ser regnestykket, men får ikke varsel ennå. ${Q("dekning")}</p>
      <div class="minute-input" id="wish-row" hidden><input id="wish-text" type="text" maxlength="200" placeholder="F.eks. Ski → Oslo S" enterkeyhint="send" style="max-width:none;flex:1"><button type="button" class="btn btn-secondary" id="wish-send" style="width:auto">Send</button></div>
      <button type="button" class="btn btn-ghost" id="wish-toggle" style="padding-left:0">Ikke din strekning? Ønsk deg en →</button>
      <button type="button" class="btn" data-next>Kom i gang</button>
      <p class="small muted">Testversjon for kolleger i Entur. Ingen adresse lagres. ${Q("test")}</p>`,
    () => `
      <h2>Togreisen ${Q("togreise")}</h2>
      <label class="field" for="f-station">Stasjonen du reiser fra
        <select id="f-station" required><option value="">Velg stasjon</option>${["E18 vest", "E18 Mosseveien", "E6 sør", "E6 nord"].filter((c) => Object.values(stations).some((s) => (s.corridor || "") === c)).concat([...new Set(Object.values(stations).map((s) => s.corridor || ""))].filter((c) => !["E18 vest", "E18 Mosseveien", "E6 sør", "E6 nord"].includes(c))).map((c) => `<optgroup label="${c || "Stasjoner"}">${Object.entries(stations).filter(([, s]) => (s.corridor || "") === c).map(([id, station]) => `<option value="${id}" ${id === d.station ? "selected" : ""}>${station.name}</option>`).join("")}</optgroup>`).join("")}</select>
      </label>
      <p id="station-coverage-note" class="hint" ${st.dark ? "" : "hidden"}>Vegvesenet måler ikke hele veien herfra. Den delen vi ikke ser regner vi som helt uten kø, så anslaget er forsiktig: er det kø der også, sparer toget mer enn vi sier. Aldri mindre.</p>
      <div class="field"><label>Når drar du vanligvis hjemmefra? ${Q("avreise")}</label><div class="chips" data-chips="leaveAt">${["06:40", "07:00", "07:15", "07:30", "07:45", "08:00", "08:15"].map((t) => `<button type="button" class="chip" data-v="${t}" aria-pressed="${d.leaveAt === t}">${t}</button>`).join("")}<button type="button" class="chip" data-v="" aria-pressed="${!d.leaveAt}">Varierer</button></div></div>
      ${minutes("toStationMin", "Uten venting på toget.")}
      <label class="field" for="f-work">Der du jobber
        <select id="f-work" required><option value="">Velg område</option>${Object.entries(areas).map(([id, area]) => `<option value="${id}" ${id === d.workArea ? "selected" : ""}>${area.label}</option>`).join("")}</select>
      </label>
      ${minutes("walkFromStationMin", "Fra toget og helt frem.")}
      <div class="row"><button type="button" class="btn btn-secondary" data-back>Tilbake</button><button type="button" class="btn" data-next>Neste</button></div>`,
    () => `
      <h2>Bilen ${Q("bilreise")}</h2>
      <p class="small muted">Samme reise med bil, en dag uten kø. Du trenger ikke kjøre bil til vanlig.</p>
      ${minutes("carFreeFlowMin", "Hjemmefra til der du parkerer.")}
      ${minutes("parkingWalkMin", "Skriv 0 hvis det ikke tar tid.")}
      <div class="total-box" aria-live="polite" aria-atomic="true"><b>Bil uten kø</b><output id="car-total">${sum == null ? "Fyll ut begge" : `${d.carFreeFlowMin ?? "?"} + ${d.parkingWalkMin ?? "?"} = ${sum} min`}</output><span class="hint">Køen på E18 legges til hver morgen.</span></div>
      <div class="row"><button type="button" class="btn btn-secondary" data-back>Tilbake</button><button type="button" class="btn" data-next>Neste</button></div>`,
    () => `
      <h2>Stemmer dette?</h2>
      ${d.profileSchemaVersion !== 2 && d.deviceId ? `<p class="ios-hint">Tidene kommer fra det gamle oppsettet. Sjekk at de stemmer før du lagrer.</p>` : ""}
      <div class="card"><p><b>${st.name || ""}</b> → ${areas[d.workArea]?.label || ""}</p><p><b>Bil uten kø:</b> ${sum == null ? "mangler tider" : sum + " min"} (${d.carFreeFlowMin ?? "?"} kjøring + ${d.parkingWalkMin ?? "?"} parkering og gange)</p><p><b>Tog:</b> ${d.toStationMin ?? "?"} min til perrongen + venting + toget + ${d.walkFromStationMin ?? "?"} min til jobb</p><p><b>Avreise:</b> ${d.leaveAt ? "vanligvis kl. " + d.leaveAt : "varierer, vi regner fra kortet kommer"}</p></div>
      <p>Varsel 06:30 og 07:00 på hverdager, bare når toget vinner. ${Q("tilstand")}</p>
      ${isIOS && !isStandalone ? `<div class="ios-hint"><b>iPhone:</b> varsler krever at appen ligger på Hjem-skjermen. ${Q("installer")} Du kan lagre nå og slå på varsler etterpå.</div>` : ""}
      ${!state.pushSupported ? `<div class="ios-hint">Denne nettleseren støtter ikke varsler. Du kan lagre og bruke «Sjekk nå».</div>` : ""}
      <div class="row"><button type="button" class="btn btn-secondary" data-back>Tilbake</button><button type="button" class="btn" id="btn-enable" ${!state.pushSupported || (isIOS && !isStandalone) ? "disabled" : ""}>Lagre og slå på varsler</button></div>
      <button type="button" class="btn btn-ghost" id="btn-skip">Lagre uten varsler</button>`,
  ];
  app.innerHTML = `<p class="small muted">${state.step ? `Steg ${state.step} av 3` : ""}</p><div class="steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i <= state.step ? "on" : ""}"></i>`).join("")}</div><form class="card lift" id="stepcard">${steps[state.step]()}</form>`;
  const remember = () => store.set("onboardingDraft", d);
  $("#wish-toggle")?.addEventListener("click", () => { track("wish_opened"); $("#wish-row").hidden = false; $("#wish-toggle").hidden = true; $("#wish-text").focus(); });
  $("#wish-send")?.addEventListener("click", async () => { const t = $("#wish-text").value.trim(); if (t.length < 3) return toast("Skriv hvor du reiser fra og til."); try { await api("/wishes", { method: "POST", body: { deviceId, text: t } }); $("#wish-row").hidden = true; toast("Takk! Ønsket er lagret."); } catch (e) { toast("Fikk ikke lagret ønsket. Prøv igjen."); } });
  $("#wish-text")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#wish-send").click(); } });
  $("#stepcard").addEventListener("submit", e => { e.preventDefault(); $("[data-next]")?.click(); });
  app.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => { if (!$("#stepcard").reportValidity()) return; if (state.step === 0) track("onboarding_start"); remember(); state.step = Math.min(steps.length - 1, state.step + 1); renderOnboarding(); $("h2")?.setAttribute("tabindex", "-1"); $("h2")?.focus(); }));
  app.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", () => { remember(); state.step = Math.max(0, state.step - 1); renderOnboarding(); }));
  const resetTimes = keys => {
    for (const key of keys) {
      d[key] = null; d.unknownFields = (d.unknownFields || []).filter(k => k !== key);
      const input = $("#f-" + key); if (input) { input.value = ""; input.disabled = false; input.required = true; }
      const unknown = $(`[data-unknown="${key}"]`); if (unknown) unknown.checked = false;
    }
  };
  // Re-render after a choice so the suggestions («Bruk forslag») match the chosen station and area.
  $("#f-station")?.addEventListener("change", e => { if(d.station !== e.target.value) resetTimes(["toStationMin"]); d.station = e.target.value; remember(); renderOnboarding(); });
  $("#f-work")?.addEventListener("change", e => { if(d.workArea !== e.target.value) resetTimes(["walkFromStationMin","carFreeFlowMin","parkingWalkMin"]); d.workArea = e.target.value; remember(); renderOnboarding(); });
  app.querySelectorAll("[data-unknown]").forEach(box => box.addEventListener("change", () => {
    const key = box.dataset.unknown;
    d.unknownFields = (d.unknownFields || []).filter(k => k !== key);
    if (box.checked) { d.unknownFields.push(key); d[key] = null; }
    remember(); renderOnboarding();
  }));
  app.querySelectorAll("[data-done]").forEach(b => b.addEventListener("click", () => { document.activeElement?.blur(); b.blur(); }));
  app.querySelectorAll('[data-chips="leaveAt"] .chip').forEach(b => b.addEventListener("click", () => { d.leaveAt = b.dataset.v || null; remember(); app.querySelectorAll('[data-chips="leaveAt"] .chip').forEach(x => x.setAttribute("aria-pressed", String(x === b))); }));
  app.querySelectorAll("[data-suggest]").forEach(b => b.addEventListener("click", () => { const input = $(`#f-${b.dataset.suggest}`); if (!input) return; input.value = b.dataset.v; input.dispatchEvent(new Event("input", { bubbles: true })); b.closest(".chips")?.remove(); }));
  app.querySelectorAll("[data-minutes]").forEach(input => input.addEventListener("input", () => {
    d[input.dataset.minutes] = minuteValue(input.value); remember();
    const total = $("#car-total"), value = carBaseline(d);
    if (total) total.textContent = value == null ? "Fyll ut begge tidene" : `${d.carFreeFlowMin == null ? "ukjent tid" : d.carFreeFlowMin + " min"} kjøring + ${d.parkingWalkMin == null ? "ukjent tid" : d.parkingWalkMin + " min"} parkering/gange = ${value} min totalt`;
  }));
  $("#btn-enable")?.addEventListener("click", () => finishOnboarding(true));
  $("#btn-skip")?.addEventListener("click", () => finishOnboarding(false));
}

async function finishOnboarding(withPush) {
  if (state.saving || !$("#stepcard").reportValidity()) return;
  state.saving = true;
  app.querySelectorAll("button").forEach(b => b.disabled = true);
  try {
    const profile = { ...confirmedProfile(state.draft), deviceId };
    if(!state.config.stations[profile.station] || !state.config.workAreas[profile.workArea]) throw new Error("Velg stasjon og arbeidsområde på nytt.");
    let stage = "varsler";
    const push = withPush ? await subscribePush() : null;
    if (withPush && !push) return;
    stage = "lagring";
    try { await answers.submit("/subscriptions", { deviceId, profile, push, slots: profile.slots, days: profile.days, client: clientFacts() }); }
    catch (e) {
      // The address may have moved while they were filling in the form: rediscover it and send once more.
      if (await discoverApi().catch(() => false)) { try { await answers.flush(); e.recovered = true; } catch {} }
      if (!e.recovered) { e.stage = stage; throw e; }
    }
    track("onboarding_saved", { withPush: !!push, station: profile.station, workArea: profile.workArea });
    profile.pushEnabled = !!push || !!state.draft.pushEnabled;
    // Server receipt callback persisted the confirmed profile.
    toast(push ? "Reisen er lagret. Du kan nå sende et testvarsel." : "Reisen er lagret.");
    await loadVerdicts();
  } catch (e) {
    console.error(e);
    // Say what failed, and log it (no personal data) so we can see it in the dashboard the next morning.
    const why = e?.status === 400 ? "skjema" : e?.status === 410 ? "slettet" : e?.stage === "lagring" ? "nett" : "varsler";
    track("save_failed", { why, stage: e?.stage || "varsler", name: String(e?.name || "").slice(0, 40), message: String(e?.message || "").slice(0, 120), status: e?.status || null });
    toast(why === "skjema" ? "Tjenesten avviste tidene. Sjekk at alle felt er hele minutter, og prøv igjen."
      : why === "nett" ? "Fikk ikke kontakt med tjenesten. Reisen er beholdt her; prøv igjen om et minutt."
      : why === "slettet" ? "Denne enheten er slettet hos tjenesten. Last siden på nytt og registrer deg igjen."
      : "Varsler kunne ikke slås på i denne nettleseren. Du kan lagre uten varsler og prøve igjen senere.");
    if (why === "nett") toast("Reisen ligger klar her og sendes automatisk så snart tjenesten svarer.", 6000);
  }
  finally { state.saving = false; render(); }
}

async function subscribePush() {
  if (!state.pushSupported) return null;
  // serviceWorker.ready can hang forever if registration failed; give it ten seconds and say so.
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("Service worker ble ikke klar"), { name: "SwNotReady" })), 10000))]);
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Varsler ble ikke tillatt."); track("push_denied", { permission: perm }); return null; }
  const key = state.config?.vapidPublicKey || CFG.vapidPublicKey;
  let sub;
  try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }); }
  catch (e) { track("push_subscribe_failed", { name: String(e?.name || "").slice(0, 40), message: String(e?.message || "").slice(0, 120) }); throw e; }
  track("push_enabled"); return sub.toJSON();
}

// What actually happened, once the drive window has closed and the road archive has been read. These two were
// stubs that always said «fasit ikke verifisert», written while the scoring was suspended. Every card is scored
// automatically now, and the person who got it — or who got nothing — is the one entitled to know.
const outcomeOf = (v) => {
  const t = v?.truth;
  if (!t?.scored) return null;
  if (v.state === "TOG_VINNER") return t.hit ? "treff" : "bom";
  return t.missedWin ? "tapt" : "riktig";
};
function truthMark(v) {
  return { treff: "vi traff", bom: "vi bommet", tapt: "vi burde varslet", riktig: "vi hadde rett" }[outcomeOf(v)] || "venter på svar";
}
function truthLine(v) {
  const t = v?.truth, o = outcomeOf(v);
  const m = t?.actualSavedMin != null ? fmtMin(Math.abs(t.actualSavedMin)) : null;
  // Viktigste først, én ting om gangen, aktiv form. Hver linje sier hva som skjedde, hva vi gjorde, og om vi
  // hadde rett. Samme setningsbygning i alle fire, så den som leser dem etter hverandre kjenner igjen formen.
  if (o === "treff") return `<p class="small ok">Toget var ${m} minutter raskere. Vi varslet, og det stemte. ${Q("fasit")}</p>`;
  if (o === "bom") return `<p class="small warn">Bilen var ${m} minutter raskere. Vi varslet, og det var feil. ${Q("fasit")}</p>`;
  if (o === "tapt") return `<p class="small warn">Toget var ${m} minutter raskere. Vi varslet ikke, og det var feil. ${Q("fasit")}</p>`;
  if (o === "riktig") return `<p class="small muted">Bilen var ${m} minutter raskere. Vi varslet ikke, og det stemte. ${Q("fasit")}</p>`;
  return `<p class="small muted">Vi regner ut svaret når kjøreturen din er over. Da henter vi køen Vegvesenet målte på veien din mens du kjørte. Togtiden er sanntidsprognosen fra da kortet ble laget, ikke en målt ankomst. ${Q("fasit")}</p>`;
}
function renderHome() {
  const p = state.profile;
  const v = state.latest;
  const st = v?.station || state.config?.stations?.[p.station] || {};
  const area = v?.work || state.config?.workAreas?.[p.workArea] || {};
  const title = { TOG_VINNER: `I dag vinner toget fra ${st.name}`, TOG_ALLTID: `Toget er raskest fra ${st.name} uansett`, INGEN_FORDEL: `Ingen togfordel i dag`, TOG_USIKKERT: `Kø på veien, men togene er usikre`, VET_IKKE: `Vet ikke i dag` };
  app.innerHTML = `
    ${v ? `
    <section class="card verdict ${v.state}" aria-labelledby="vh">
      <div class="eyebrow"><span>${dateLabel(v.issuedAt)} kl. ${v.slot === "now" ? hhmm(v.issuedAt) : v.slot}</span>${v.slot === "now" ? `<span class="pill">sjekket nå</span>` : ""}${CFG.testMode ? `<span class="pill">test</span>` : ""} ${Q("tilstand")}</div>
      <h1 id="vh">${v.state === "TOG_VINNER" && v.sources?.datex?.routeVerified !== true ? "Modellen anslår togfordel" : title[v.state] || v.state}</h1>
      <p>${v.reason}</p>
      ${v.sources?.datex?.routeVerified !== true ? `<p class="small">Bilanslaget bruker en stasjonskorridor. Din påkjøring og faktiske bilrute er ikke verifisert. Ordinære varsler er sperret inntil ruten er avklart; testvarsel kan fortsatt brukes.</p>` : ""}
      ${v.savedMin != null && v.state === "TOG_VINNER" ? `<p><b>${v.sources?.datex?.routeVerified === true ? "Du sparer ca." : "Modellen anslår ca."} ${fmtMin(v.savedMin)} min${v.sources?.datex?.routeVerified === true ? "." : " forskjell."}</b> ${Q("sparer")}</p>` : ""}
      <div class="compare">
        <div class="side"><span class="lbl">Bil i dag ${Q("bil")}</span><span class="num">${fmtMin(v.car.totalMin)}<small> min</small></span><span class="parts">${v.car.totalMin != null ? `${v.car.freeFlowMin} fri flyt + ${fmtMin(Math.max(0, v.car.delayMin))} kø + ${v.car.parkingWalkMin} parkering` : "mangler grunnlag"}</span></div>
        <div class="side"><span class="lbl">Tog i dag ${Q("tog")}</span><span class="num">${fmtMin(v.train.totalMin)}<small> min</small></span><span class="parts">${fmtMin(v.train.toStationMin)} til stasjon + ${fmtMin(v.train.waitMin)} venting + ${fmtMin(v.train.railMin)} tog + ${fmtMin(v.train.walkMin)} gange</span></div>
      </div>
      ${v.car?.forecast && v.car.forecast.horizonMin > 15 ? `<p class="small">Ventet kø når du drar kl. ${hhmm(v.car.leaveAt)}: <b>${Math.round(v.car.forecast.delayMin)} min</b> (${Math.round(v.car.forecast.lowMin)}–${Math.round(v.car.forecast.highMin)}). Nå: ${Math.round(v.car.delayNowMin ?? v.car.delayMin)} min. ${Q("avreise")}</p>` : ""}
      ${truthLine(v)}
      <details class="sources"><summary>Grunnlaget for sammenligningen</summary>
        <p>Inntastede tider: ${v.audit?.inputBasis === "user_estimate" ? "dine anslag" : "eldre verdier som må kontrolleres"}.</p>
        <p>Veidata: ${v.sources?.datex?.segmentCoverage ? `${v.sources.datex.segmentCoverage.usableCount} av ${v.sources.datex.segmentCoverage.expectedCount} strekninger har brukbare, ferske målinger` : "dekning ikke dokumentert"}. ${v.sources?.datex?.route ? `Bilrute: ${st.corridor || "veien"} fra påkjøringen ved ${v.sources.datex.route.onRamp} til avkjøringen for arbeidsområdet. ${v.sources.datex.route.note}` : "Dette er ikke bekreftet dekning av din bilrute."}</p>
        ${(v.car?.roadOptions || []).length > 1 ? `<p>Veivalg: ${v.car.roadOptions.map((o) => o.usable ? `<b>${o.road}</b> ${o.delayMin} min kø${o.extraFreeFlowMin ? ` + ${o.extraFreeFlowMin} min lengre vei` : ""}${o.road === v.car.road ? " ← brukt" : ""}` : `${o.road}: ${o.why}`).join("<br>")}<br><span class="muted">Vi regner bilen på den raskeste veien du kan velge i dag, ikke bare den du pleier å ta.</span></p>` : ""}
        <p>Tog: ${v.sources?.journeyPlanner?.ok ? "forventede tider" : "kilde mangler"}. Faktisk togankomst og personlig bilreise er ikke observert.</p>
      </details>
      ${v.car.delayMin != null ? `<p class="small">${v.car.road || "Veien"} mot Oslo: <b>${fmtMin(v.car.delayMin)} min</b> forsinkelse, trend ${{ increasing: "økende", decreasing: "avtagende", stable: "stabil" }[v.car.trend] || v.car.trend}. ${Q("kø")}</p>` : ""}
    </section>
    <section class="card">
      <h3>Neste tog ${st.name} → ${area.label?.split(" / ")[0] || "Oslo S"} ${Q("togstatus")}</h3>
      <div class="trains">${v.train.next.length ? v.train.next.map((t) => `<div class="train"><span class="time">${hhmm(t.departs)}</span><span class="line">${t.line} · ${fmtMin(t.minutes)} min · fremme ${hhmm(t.arrives)}</span><span class="rt">${t.realtime ? "sanntid" : "rutetid"}</span></div>`).join("") : `<p class="muted small">Fant ingen direkte tog akkurat nå.</p>`}</div>
      ${v.train.alerts?.length ? `<p class="small"><b>Avviksvarsel:</b> ${v.train.alerts.map((a) => a.title).join("; ")}</p>` : `<p class="small muted">${v.sources?.railAlerts?.ok ? "Ingen sterke avviksvarsler blant reisene tjenesten dekker. Dette er ikke en garanti for at togene går normalt." : "Avviksvarsel kunne ikke bekreftes nå."}</p>`}
    </section>
    <section class="card feedback">
      <h3>Stemte det?</h3>
      <div class="row"><button class="btn btn-secondary" data-fb="useful">👍 Nyttig</button><button class="btn btn-secondary" data-fb="not_useful">👎 Ikke nyttig</button></div>
      <p class="small muted">Hva gjorde du i dag?</p>
      <div class="row"><button class="btn btn-secondary" data-fb="took_train">Tok toget</button><button class="btn btn-secondary" data-fb="took_car">Tok bilen</button><button class="btn btn-secondary" data-fb="wfh">Hjemme</button></div>
    </section>` : `
    <section class="card verdict VET_IKKE"><div class="eyebrow">Ikke noe kort ennå</div><h1>Reisen din er lagret</h1><p>Første regnestykke kommer 06:30 neste hverdag. Du får varsel bare hvis toget vinner. «Sjekk nå» viser tallene akkurat nå.</p></section>`}
    ${p.leaveAt === undefined || (p.leaveAt == null && !store.get("leaveAtDismissed")) ? `<section class="card ios-hint"><b>Nytt: si når du drar.</b> Da blir kortet en prognose for din avreise, ikke bare køen akkurat nå. <div class="row" style="margin-top:.5rem"><button class="btn btn-secondary" id="leave-edit" style="width:auto">Legg inn avreisetid</button><button class="btn btn-ghost" id="leave-dismiss" style="width:auto">Varierer</button></div></section>` : ""}
    <section class="card wish"><h3>Mangler din strekning?</h3><p class="small muted">Si hvor du reiser fra og til, så prioriterer vi etter ønskene.</p>
      <div class="minute-input"><input id="wish-text" type="text" maxlength="200" placeholder="F.eks. Ski → Oslo S" enterkeyhint="send" style="max-width:none;flex:1"><button class="btn btn-secondary" id="wish-send" style="width:auto">Send</button></div></section>
    <div class="row"><button class="btn" id="btn-now">Sjekk nå</button>${p.pushEnabled ? `<button class="btn btn-secondary" id="btn-test">Send testvarsel</button>` : `<button class="btn btn-secondary" id="btn-push">Slå på varsler</button>`}</div>
    ${state.verdicts.length > 1 ? `<section class="card"><h3>Tidligere kort</h3><div class="history">${state.verdicts.slice(1, 12).map((h) => `<div class="hist"><span class="dot ${h.state}"></span><span>${dateLabel(h.issuedAt)} ${h.slot === "now" ? hhmm(h.issuedAt) : h.slot} · ${h.state === "TOG_VINNER" ? "Modellert togfordel fra " + h.station.name : {INGEN_FORDEL:"Ingen togfordel",TOG_USIKKERT:"Tog usikkert",VET_IKKE:"Vet ikke"}[h.state] || h.state}</span><span class="muted">${truthMark(h)}</span></div>`).join("")}</div></section>` : ""}
    <section class="sources">
      <span><b>Kilder</b> ${Q("ferskhet")}</span>
      <span>Vei: Statens vegvesen DATEX II${v?.sources?.datex?.ageMin != null ? `, ${fmtMin(v.sources.datex.ageMin)} min gamle tall` : ""}. Tog: Entur Avviksvarsel og Journey Planner.</span>
      <span>${v ? "Reisen i dette kortet" : "Din reise"}: ${st.name} → ${area.label}. ${carBaselineSummary(v ? {carFreeFlowMin:v.car.freeFlowMin,parkingWalkMin:v.car.parkingWalkMin} : p)}</span>
    </section>`;
  $("#btn-now").addEventListener("click", () => { track("check_now"); checkNow(); });
  $("#leave-edit")?.addEventListener("click", () => { state.draft = { ...p }; state.profile = null; state.step = 1; render(); });
  $("#leave-dismiss")?.addEventListener("click", () => { store.set("leaveAtDismissed", true); render(); });
  $("#wish-send")?.addEventListener("click", async () => { const t = $("#wish-text").value.trim(); if (t.length < 3) return toast("Skriv hvor du reiser fra og til."); try { await api("/wishes", { method: "POST", body: { deviceId, text: t } }); $("#wish-text").value = ""; toast("Takk! Ønsket er lagret."); } catch (e) { toast("Fikk ikke lagret ønsket. Prøv igjen."); } });
  $("#wish-text")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#wish-send").click(); } });
  $("#btn-test")?.addEventListener("click", async () => { try { await api(`/subscriptions/${deviceId}/test`, { method: "POST" }); toast("Testvarsel sendt. Sjekk varslingssenteret."); } catch (e) { toast("Klarte ikke sende: " + e.message); } });
  $("#btn-push")?.addEventListener("click", async () => { try { const push = await subscribePush(); if (!push) return; await answers.submit("/subscriptions", { deviceId, profile: state.profile, push, slots: state.profile.slots, days: state.profile.days, client: clientFacts() }); state.profile.pushEnabled = true; store.set("profile", state.profile); toast("Varsler er på."); render(); } catch (e) { toast("Feil: " + e.message); } });
  app.querySelectorAll("[data-fb]").forEach((b) => b.addEventListener("click", async () => { try { b.disabled=true; await answers.submit("/feedback", { deviceId, verdictId: v?.id || null, kind: b.dataset.fb }); b.textContent = "Lagret hos tjenesten"; b.disabled = true; } catch (e) { b.disabled=false; toast("Ikke bekreftet lagret. Svaret beholdes i sendekøen hvis nettleserlagringen virker.",6000); } }));
}

async function checkNow() {
  const b = $("#btn-now"); b.disabled = true; b.textContent = "Regner…";
  try { const v = await api(`/now?deviceId=${encodeURIComponent(deviceId)}`); v.slot = "now"; state.latest = v; state.verdicts = [v, ...state.verdicts.filter((x) => x.id !== v.id)]; render(); }
  catch (e) { toast("Klarte ikke regne nå: " + e.message); b.disabled = false; b.textContent = "Sjekk nå"; }
}

function renderSettings() {
  const p = state.profile;
  app.innerHTML = `<section class="card lift">
    <h2>Innstillinger</h2><p>${answers.pending()} svar venter på lagringskvittering.</p><button class="btn btn-secondary" id="s-retry">Prøv lagring igjen</button>
    <p class="small muted">Enhet ${deviceId.slice(0, 8)}. Varsler ${p.pushEnabled ? "på" : "av"}. Kort ${p.slots.join(" og ")}.</p>
    <button class="btn btn-secondary" id="s-edit">Endre reisen min</button>
    <button class="btn btn-secondary" id="s-off">Skru av varsler</button>
    <button class="btn btn-secondary" id="s-delete" style="color:#b62f2f">Slett alt om meg</button>
    <button class="btn btn-ghost" id="s-back">Tilbake</button>
    <p class="small muted">Testperiode. Spørsmål: KIX-teamet i Entur.</p>
  </section>`;
  $("#s-retry").addEventListener("click",retryAnswers);
  $("#s-back").addEventListener("click", render);
  $("#s-edit").addEventListener("click", () => { state.draft = { ...p }; state.profile = null; state.step = 1; render(); });
  $("#s-off").addEventListener("click", async () => { try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); await sub?.unsubscribe(); await api(`/subscriptions/${deviceId}/push`, { method: "DELETE" }); p.pushEnabled = false; store.set("profile", p); toast("Varsler er av."); render(); } catch (e) { toast("Feil: " + e.message); } });
  $("#s-delete").addEventListener("click", async () => {
    if (!confirm("Slette alt vi har lagret om denne enheten?")) return;
    try { await answers.deleteWith(()=>api(`/subscriptions/${deviceId}`, { method: "DELETE" })); }
    catch { toast("Kunne ikke slette hos tjenesten. Prøv igjen; vi har ikke bekreftet sletting."); return; }
    store.del("profile"); store.del("deviceId"); store.del("onboardingDraft");
    state.draft = null; state.profile = null; state.verdicts = []; state.latest = null; state.step = 0;
    toast("Slettet."); location.reload();
  });
}
$("#btn-settings").addEventListener("click", renderSettings);

async function loadVerdicts() {
  try { const r = await api(`/verdicts?deviceId=${encodeURIComponent(deviceId)}&limit=12`); state.verdicts = r.verdicts || []; state.latest = state.verdicts[0] || null; } catch (e) { console.warn(e); }
}

// Local demo hook (screenshots): render a verdict object handed in by the test runner.
window.addEventListener("demo-verdict", (e) => { state.latest = e.detail; state.verdicts = [e.detail, ...state.verdicts]; render(); });

// ---------- boot ----------
(async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js?api=" + encodeURIComponent(new URL(API, location.href).href), { updateViaCache: "none" }).catch((e) => console.warn("sw", e));
    // A new version of the app activates in the background; offer one tap to load it (no reinstall, ever).
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) { const t = $("#toast"); t.innerHTML = 'Ny versjon av Reisevalg er klar. <button class="chip" id="reload-now" style="margin-left:.4rem">Oppdater</button>'; t.hidden = false; $("#reload-now").addEventListener("click", () => location.reload()); } hadController = true; });
    navigator.serviceWorker.addEventListener("message", async (e) => {
      if (e.data?.type === "open-verdict") { track("notification_click", { verdictId: e.data.verdictId || "" }); await loadVerdicts(); render(); }
      if (e.data?.type === "resubscribe" && state.profile) { try { await answers.submit("/subscriptions", { deviceId, profile: state.profile, push: e.data.subscription, slots: state.profile.slots, days: state.profile.days }); } catch {} }
    });
  }
  state.profile = store.get("profile");
  state.config = CFG.staticConfig ? { ...CFG.staticConfig, vapidPublicKey: CFG.vapidPublicKey } : { stations: {}, workAreas: {}, vapidPublicKey: CFG.vapidPublicKey };
  render(); // never make the first screen wait for the network
  track("app_open", { hasProfile: !!state.profile, step: state.step });
  api("/config").then((c) => { state.config = c; if (!state.profile && state.step === 0) render(); }).catch(() => { if (!Object.keys(state.config.stations).length) toast("Får ikke kontakt med tjenesten. Prøv igjen om litt."); });
  if (state.profile) { await loadVerdicts(); render(); }
})();
