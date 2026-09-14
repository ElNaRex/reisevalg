// Shared input semantics for onboarding and server validation. Minutes are user estimates,
// never measured travel times. No car use or travel-mode preference is inferred.
export const MINUTE_FIELDS = {
  toStationMin: { max: 120, label: "Hjem til klar på perrongen" },
  walkFromStationMin: { max: 120, label: "Fra ankomststasjonen til jobb" },
  carFreeFlowMin: { max: 240, label: "Kjøretid uten kø" },
  parkingWalkMin: { max: 120, label: "Parkering og gange til jobb" },
};

export function minuteValue(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

export function profileErrors(profile) {
  const p = profile || {};
  const unknown = Array.isArray(p.unknownFields) ? p.unknownFields : [];
  if ((p.unknownFields != null && !Array.isArray(p.unknownFields)) || unknown.some(k => !Object.hasOwn(MINUTE_FIELDS,k) || p[k] !== null))
    return [{field:"unknownFields",message:"Ukjente tider må være tomme og knyttet til et gyldig tidsfelt."}];
  return Object.entries(MINUTE_FIELDS).filter(([key, rule]) =>
    !(unknown.includes(key) && p[key] === null) && (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > rule.max)
  ).map(([key, rule]) => ({ field: key, message: `${rule.label}: oppgi hele minutter fra 0 til ${rule.max}.` }));
}

export function carBaseline(profile) {
  const p = profile || {};
  return [p.carFreeFlowMin, p.parkingWalkMin].every(n => Number.isFinite(n) && n >= 0)
    ? p.carFreeFlowMin + p.parkingWalkMin : null;
}

export function carBaselineSummary(profile) {
  const total = carBaseline(profile);
  if (total == null) return "Bil totalt uten kø: mangler oppgitt kjøretid eller parkering/gange.";
  return `Kjøring uten kø ${profile.carFreeFlowMin} min + parkering/gange ${profile.parkingWalkMin} min = ${total} min totalt.`;
}

export function confirmedProfile(draft, confirmedAt = new Date().toISOString()) {
  if (profileErrors(draft).length || !draft.station || !draft.workArea) throw new Error("Fullfør reisetidene først.");
  return {
    station: draft.station, workArea: draft.workArea,
    ...Object.fromEntries(Object.keys(MINUTE_FIELDS).map(k => [k, draft[k]])),
    unknownFields: Object.keys(MINUTE_FIELDS).filter(k => draft[k] === null),
    slots: [...draft.slots], days: [...draft.days],
    profileSchemaVersion: 2,
    timeInputs: { basis: "user_estimate", confirmedAt },
  };
}
