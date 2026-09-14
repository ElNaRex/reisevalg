import { answerQueue } from './answer-queue.mjs';
import { MINUTE_FIELDS, minuteValue, carBaseline, carBaselineSummary, confirmedProfile } from "./journey-profile.mjs";
// Reisevalg PWA. Vanilla JS, no build step. Screens: onboarding → home → settings.
const CFG = window.REISEVALG_CONFIG;
// The API host may move (tunnel rotation, later Supabase). Order: the last base that worked on this device,
// then config.js, then the discovery file. A base is kept only after /config answered.
let API = (() => { try { const s = localStorage.getItem("apiBase"); if (s && /^https?:\/\//.test(s)) return s.replace(/\/$/, ""); } catch {} return CFG.apiBase.replace(/\/$/, ""); })();
async function discoverApi() {
  const candidates = [CFG.apiBase.replace(/\/$/, "")];
  if (CFG.apiDiscoveryUrl) { try { const r = await fetch(CFG.apiDiscoveryUrl + (CFG.apiDiscoveryUrl.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(8000) }); const j = await r.json(); if (j.apiBase && /^https:\/\//.test(j.apiBase)) candidates.unshift(j.apiBase.replace(/\/$/, "")); } catch {} }
  for (const base of candidates) {
    if (base === API) continue;
    try { const r = await fetch(base + "/config", { headers: { "Bypass-Tunnel-Reminder": "true" }, signal: AbortSignal.timeout(8000) }); if (r.ok) { API = base; try { localStorage.setItem("apiBase", base); } catch {} return true; } } catch {}
  }
  return false;
}
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const state = { profile: null, config: null, verdicts: [], latest: null, pushSupported: "serviceWorker" in navigator && "PushManager" in window, step: 0 };

const HELP = {
  bil: ["Bil i dag", "Kjøretiden uten kø du oppga + modellert køtillegg + parkering og gange til jobb. Dine egne tider er anslag. DATEX beskriver veistrekninger, ikke en observert personlig biltur."],
  tog: ["Tog i dag", "Tiden du bruker til stasjonen, ventetid til neste tog etter at du rekker fram, togets kjøretid med sanntid fra Entur, og gangen fra stasjonen til jobb."],
  sparer: ["Du sparer", "Bil i dag minus tog i dag. Vi sier bare at toget vinner når differansen er minst 10 minutter og togene i ditt tidsvindu ikke har varsler i Avviksvarsel. Hvis køen er i ferd med å løse seg opp krever vi 15."],
  kø: ["Forsinkelse på E18", "Summen av målt reisetid minus fri flyt på strekningene Statens vegvesen dekker mot Oslo. Trenden sier om køen øker, er stabil eller avtar. Lier–Holmen mangler måling i dag, så for Lier og Brakerøya kan vi ikke svare før Vegvesenet skrur på strekningen."],
  togstatus: ["Togene i dag", "Avviksvarsel omfatter reisene tjenesten dekker. Tom varslingsliste er ingen garanti for normal trafikk. Journey Planner viser forventede tider, ikke dokumentasjon på faktisk ankomst."],
  tilstand: ["Hva kortet kan si", "«I dag vinner toget» er det eneste varselet vi sender. Slår bilen toget, får du ingen melding. Åpner du appen, ser du likevel dagens regnestykke: «ingen togfordel», «togene er usikre» eller «vet ikke». Vi sier aldri «ta bilen»."],
  test: ["Testperiode", "Du er med i en test med kolleger. Varsel kommer bare de morgenene toget vinner; de andre morgenene er det stille. Alt du svarer på kortet brukes til å måle om varselet treffer. Vi lagrer ingen adresse, bare stasjon, arbeidsområde og minuttene du oppgir."],
  fasit: ["Fasit", "Automatisk etterkontroll er suspendert. Togtidene er prognoser. Bilalternativet er et modellanslag fra DATEX og dine oppgitte tider, ikke en observert personlig biltur. Vi har ennå ikke verifisert om anbefalingene traff."],
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
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const hhmm = (iso) => new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const fmtMin = n => Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "–";
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
  const d = state.draft || (state.draft = store.get("onboardingDraft") || { station: "", workArea: "", toStationMin: null, walkFromStationMin: null, carFreeFlowMin: null, parkingWalkMin: null, slots: ["06:30", "07:00"], days: [0, 1, 2, 3, 4] });
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
  const minutes = (key, hint) => `<div class="field"><label for="f-${key}">${MINUTE_FIELDS[key].label}</label><div class="minute-input"><input id="f-${key}" data-minutes="${key}" type="number" inputmode="numeric" min="0" max="${MINUTE_FIELDS[key].max}" step="1" ${d.unknownFields?.includes(key) ? "disabled" : "required"} value="${Number.isFinite(d[key]) ? d[key] : ""}" aria-describedby="hint-${key}"><span aria-hidden="true">min</span></div><span class="hint" id="hint-${key}">${hint}</span>${suggest(key)}<label class="confirm-times hint"><input type="checkbox" data-unknown="${key}" ${d.unknownFields?.includes(key) ? "checked" : ""}>Vet ikke ennå</label></div>`;
  const sum = carBaseline(d);
  const steps = [
    () => `
      <h1>Bil eller tog fra hjem til jobb?</h1>
      <p>Sammenlign de to alternativene, uansett hvordan du reiser til vanlig. Du oppgir tidene som er særegne for reisen din; vi henter tilgjengelige tog- og veidata.</p>
      <div class="card"><p><b>Samme start og mål:</b> hjemmefra til du er fremme på jobb. Kjøring, parkering og gange skal være med.</p><p class="small muted">Tidene du oppgir er anslag. Ingen adresse eller vanlig reisemåte registreres.</p></div>
      <p class="small muted">Testversjon for kolleger. Du får varsel bare de morgenene toget vinner. Slår bilen toget, er det stille. Åpner du appen, ser du regnestykket uansett.</p>
      ${!available ? `<p role="alert">Får ikke hentet stasjoner og arbeidsområder. Prøv igjen når tjenesten er tilgjengelig.</p>` : ""}
      <button type="button" class="btn" data-next ${!available ? "disabled" : ""}>Kom i gang</button>`,
    () => `
      <h2>Togreisen fra dør til dør</h2>
      <p>Oppgi tidene uten selve togturen og ventetiden på toget. Disse beregner vi fra avgangen.</p>
      <label class="field" for="f-station">Stasjonen du ville reist fra
        <select id="f-station" required><option value="">Velg stasjon</option>${Object.entries(stations).map(([id, station]) => `<option value="${id}" ${id === d.station ? "selected" : ""}>${station.name}</option>`).join("")}</select>
      </label>
      <p id="station-coverage-note" class="hint" ${st.dark ? "" : "hidden"}>Veimålinger mangler på deler av denne korridoren. Vi viser «vet ikke» når grunnlaget ikke holder.</p>
      ${minutes("toStationMin", "Fra du går hjemmefra til du er klar til å gå om bord. Ta med eventuell kjøring, sykkelparkering eller bilparkering og gange til perrongen. Ikke ta med venting på toget.")}
      <label class="field" for="f-work">Arbeidsområdet ditt
        <select id="f-work" required><option value="">Velg arbeidsområde</option>${Object.entries(areas).map(([id, area]) => `<option value="${id}" ${id === d.workArea ? "selected" : ""}>${area.label}</option>`).join("")}</select>
      </label>
      ${minutes("walkFromStationMin", "Fra du går av toget ved arbeidsområdet, til du er fremme på jobb. Ta med tiden ut av stasjonen og hele veien til arbeidsplassen.")}
      <div class="row"><button type="button" class="btn btn-secondary" data-back>Tilbake</button><button type="button" class="btn" data-next>Neste</button></div>`,
    () => `
      <h2>Bilalternativet fra dør til dør</h2>
      <p>Hvor lang tid ville reisen tatt med bil uten kø? Du trenger ikke å bruke bil til vanlig.</p>
      ${minutes("carFreeFlowMin", "Bare kjøringen fra hjemmet til parkeringsstedet ved jobb, på en dag uten kø. Parkering og gange oppgir du under.")}
      ${minutes("parkingWalkMin", "Fra du avslutter kjøringen: tiden til å parkere og gå helt frem til jobb. Oppgi 0 hvis det ikke tar ekstra tid.")}
      <div class="total-box" aria-live="polite" aria-atomic="true"><b>Bil totalt uten kø</b><output id="car-total">${sum == null ? "Fyll ut begge tidene" : `${d.carFreeFlowMin == null ? "ukjent tid" : d.carFreeFlowMin + " min"} kjøring + ${d.parkingWalkMin == null ? "ukjent tid" : d.parkingWalkMin + " min"} parkering/gange = ${sum} min totalt`}</output><span class="hint">Kø legges til dette totalanslaget når veidata og bilruten kan brukes. Ingen skjulte ekstraminutter.</span></div>
      <p class="small muted">Usikker? Velg «Vet ikke ennå». Du kan lagre reisen, men vi gir ingen sammenligning før nødvendige tider er fylt ut. Tall du oppgir registreres som anslag, ikke som målt reisetid.</p>
      <div class="row"><button type="button" class="btn btn-secondary" data-back>Tilbake</button><button type="button" class="btn" data-next>Neste</button></div>`,
    () => `
      <h2>Kontroller reisen din</h2>
      ${d.profileSchemaVersion !== 2 && d.deviceId ? `<p class="ios-hint">Disse tidene kommer fra det gamle oppsettet og kan inneholde standardverdier. Kontroller at kjøring, parkering og gange har riktig betydning før du lagrer.</p>` : ""}
      <div class="card"><p><b>${st.name || ""}</b> → ${areas[d.workArea]?.label || ""}</p><p><b>Bil uten kø: ${sum == null ? "mangler tider" : sum + " min totalt"}</b><br>${d.carFreeFlowMin == null ? "ukjent tid" : d.carFreeFlowMin + " min"} kjøring + ${d.parkingWalkMin == null ? "ukjent tid" : d.parkingWalkMin + " min"} parkering og gange.</p><p><b>Tog:</b> ${d.toStationMin == null ? "ukjent tid" : d.toStationMin + " min"} til perrongen + venting + togturen + ${d.walkFromStationMin == null ? "ukjent tid" : d.walkFromStationMin + " min"} fra ankomststasjonen til jobb.</p><p class="small muted">Begge alternativer måles fra du går hjemmefra til du er fremme på jobb. Tidene over er dine anslag.</p></div>
      <label class="confirm-times"><input id="confirm-times" type="checkbox" required><span>Jeg har kontrollert tidene. Parkering og gange er med én gang i hvert alternativ. Det jeg ikke vet, er markert som ukjent.</span></label>
      <p>Varselet kommer 06:30 og 07:00 på hverdager, bare når toget vinner. Slår bilen toget, sender vi ingenting. Du kan også lagre uten varsler.</p>
      ${isIOS && !isStandalone ? `<div class="ios-hint"><b>iPhone:</b> legg appen til på Hjem-skjermen via Del, og åpne den derfra for å aktivere varsler. Du kan lagre reisen uten varsler nå.</div>` : ""}
      ${!state.pushSupported ? `<div class="ios-hint">Denne nettleseren støtter ikke push. Du kan lagre og bruke «Sjekk nå».</div>` : ""}
      <div class="row"><button type="button" class="btn btn-secondary" data-back>Tilbake</button><button type="button" class="btn" id="btn-enable" ${!state.pushSupported || (isIOS && !isStandalone) ? "disabled" : ""}>Lagre og slå på varsler</button></div>
      <button type="button" class="btn btn-ghost" id="btn-skip">Lagre uten varsler</button>`,
  ];
  app.innerHTML = `<p class="small muted">${state.step ? `Steg ${state.step} av 3` : "Tilpass sammenligningen"}</p><div class="steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i <= state.step ? "on" : ""}"></i>`).join("")}</div><form class="card lift" id="stepcard">${steps[state.step]()}</form>`;
  const remember = () => store.set("onboardingDraft", d);
  $("#stepcard").addEventListener("submit", e => { e.preventDefault(); $("[data-next]")?.click(); });
  app.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => { if (!$("#stepcard").reportValidity()) return; remember(); state.step = Math.min(steps.length - 1, state.step + 1); renderOnboarding(); $("h2")?.setAttribute("tabindex", "-1"); $("h2")?.focus(); }));
  app.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", () => { remember(); state.step = Math.max(0, state.step - 1); renderOnboarding(); }));
  const resetTimes = keys => {
    for (const key of keys) {
      d[key] = null; d.unknownFields = (d.unknownFields || []).filter(k => k !== key);
      const input = $("#f-" + key); if (input) { input.value = ""; input.disabled = false; input.required = true; }
      const unknown = $(`[data-unknown="${key}"]`); if (unknown) unknown.checked = false;
    }
  };
  $("#f-station")?.addEventListener("change", e => { if(d.station !== e.target.value) resetTimes(["toStationMin"]); d.station = e.target.value; $("#station-coverage-note").hidden = !stations[d.station]?.dark; remember(); });
  $("#f-work")?.addEventListener("change", e => { if(d.workArea !== e.target.value) resetTimes(["walkFromStationMin","carFreeFlowMin","parkingWalkMin"]); d.workArea = e.target.value; remember(); });
  app.querySelectorAll("[data-unknown]").forEach(box => box.addEventListener("change", () => {
    const key = box.dataset.unknown;
    d.unknownFields = (d.unknownFields || []).filter(k => k !== key);
    if (box.checked) { d.unknownFields.push(key); d[key] = null; }
    remember(); renderOnboarding();
  }));
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
    const push = withPush ? await subscribePush() : null;
    if (withPush && !push) return;
    await answers.submit("/subscriptions", { deviceId, profile, push, slots: profile.slots, days: profile.days });
    profile.pushEnabled = !!push || !!state.draft.pushEnabled;
    // Server receipt callback persisted the confirmed profile.
    toast(push ? "Reisen er lagret. Du kan nå sende et testvarsel." : "Reisen er lagret.");
    await loadVerdicts();
  } catch (e) { console.error(e); toast("Fikk ikke lagret. Reisen er beholdt; prøv igjen."); }
  finally { state.saving = false; render(); }
}

async function subscribePush() {
  if (!state.pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Varsler ble ikke tillatt."); return null; }
  const key = state.config?.vapidPublicKey || CFG.vapidPublicKey;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  return sub.toJSON();
}

function truthMark() {
  return "fasit ikke verifisert";
}
function truthLine() {
  return `<p class="small muted">Fasit er ikke verifisert. Togtidene er prognoser; bilalternativet er et modellanslag, ikke en observert personlig biltur. ${Q("fasit")}</p>`;
}
function renderHome() {
  const p = state.profile;
  const v = state.latest;
  const st = v?.station || state.config?.stations?.[p.station] || {};
  const area = v?.work || state.config?.workAreas?.[p.workArea] || {};
  const title = { TOG_VINNER: `I dag vinner toget fra ${st.name}`, INGEN_FORDEL: `Ingen togfordel i dag`, TOG_USIKKERT: `Kø på E18, men togene er usikre`, VET_IKKE: `Vet ikke i dag` };
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
      ${truthLine(v)}
      <details class="sources"><summary>Grunnlaget for sammenligningen</summary>
        <p>Inntastede tider: ${v.audit?.inputBasis === "user_estimate" ? "dine anslag" : "eldre verdier som må kontrolleres"}.</p>
        <p>Veidata: ${v.sources?.datex?.segmentCoverage ? `${v.sources.datex.segmentCoverage.usableCount} av ${v.sources.datex.segmentCoverage.expectedCount} strekninger har brukbare, ferske målinger` : "dekning ikke dokumentert"}. ${v.sources?.datex?.route ? `Bilrute: E18 fra påkjøringen ved ${v.sources.datex.route.onRamp} til avkjøringen for arbeidsområdet. ${v.sources.datex.route.note}` : "Dette er ikke bekreftet dekning av din bilrute."}</p>
        <p>Tog: ${v.sources?.journeyPlanner?.ok ? "forventede tider" : "kilde mangler"}. Faktisk togankomst og personlig bilreise er ikke observert.</p>
      </details>
      ${v.car.delayMin != null ? `<p class="small">E18 mot Oslo: <b>${fmtMin(v.car.delayMin)} min</b> forsinkelse, trend ${{ increasing: "økende", decreasing: "avtagende", stable: "stabil" }[v.car.trend] || v.car.trend}. ${Q("kø")}</p>` : ""}
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
    <div class="row"><button class="btn" id="btn-now">Sjekk nå</button>${p.pushEnabled ? `<button class="btn btn-secondary" id="btn-test">Send testvarsel</button>` : `<button class="btn btn-secondary" id="btn-push">Slå på varsler</button>`}</div>
    ${state.verdicts.length > 1 ? `<section class="card"><h3>Tidligere kort</h3><div class="history">${state.verdicts.slice(1, 12).map((h) => `<div class="hist"><span class="dot ${h.state}"></span><span>${dateLabel(h.issuedAt)} ${h.slot === "now" ? hhmm(h.issuedAt) : h.slot} · ${h.state === "TOG_VINNER" ? "Modellert togfordel fra " + h.station.name : {INGEN_FORDEL:"Ingen togfordel",TOG_USIKKERT:"Tog usikkert",VET_IKKE:"Vet ikke"}[h.state] || h.state}</span><span class="muted">${truthMark(h)}</span></div>`).join("")}</div></section>` : ""}
    <section class="sources">
      <span><b>Kilder</b> ${Q("ferskhet")}</span>
      <span>Vei: Statens vegvesen DATEX II${v?.sources?.datex?.ageMin != null ? `, ${fmtMin(v.sources.datex.ageMin)} min gamle tall` : ""}. Tog: Entur Avviksvarsel og Journey Planner.</span>
      <span>${v ? "Reisen i dette kortet" : "Din reise"}: ${st.name} → ${area.label}. ${carBaselineSummary(v ? {carFreeFlowMin:v.car.freeFlowMin,parkingWalkMin:v.car.parkingWalkMin} : p)}</span>
    </section>`;
  $("#btn-now").addEventListener("click", checkNow);
  $("#btn-test")?.addEventListener("click", async () => { try { await api(`/subscriptions/${deviceId}/test`, { method: "POST" }); toast("Testvarsel sendt. Sjekk varslingssenteret."); } catch (e) { toast("Klarte ikke sende: " + e.message); } });
  $("#btn-push")?.addEventListener("click", async () => { try { const push = await subscribePush(); if (!push) return; await answers.submit("/subscriptions", { deviceId, profile: state.profile, push, slots: state.profile.slots, days: state.profile.days }); state.profile.pushEnabled = true; store.set("profile", state.profile); toast("Varsler er på."); render(); } catch (e) { toast("Feil: " + e.message); } });
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
    navigator.serviceWorker.addEventListener("message", async (e) => {
      if (e.data?.type === "open-verdict") { await loadVerdicts(); render(); }
      if (e.data?.type === "resubscribe" && state.profile) { try { await answers.submit("/subscriptions", { deviceId, profile: state.profile, push: e.data.subscription, slots: state.profile.slots, days: state.profile.days }); } catch {} }
    });
  }
  state.profile = store.get("profile");
  try { state.config = await api("/config"); } catch (e) { state.config = { stations: {}, workAreas: {}, vapidPublicKey: CFG.vapidPublicKey }; toast("Får ikke kontakt med tjenesten. Prøv igjen om litt."); }
  if (state.profile) await loadVerdicts();
  render();
})();
