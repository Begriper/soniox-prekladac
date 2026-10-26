"use strict";
// Terms are spelling hints. Translation terms are intentionally limited to
// unambiguous identical abbreviations; domain vocabulary needs human review.
const PROFILES = Object.freeze({
  conversation: { label: "Bežný rozhovor", general: [{ key: "setting", value: "Everyday face-to-face conversation" }], terms: [] },
  office: { label: "Úrad", general: [{ key: "domain", value: "Public administration" }, { key: "setting", value: "In-person office appointment" }], terms: ["formulár", "žiadosť", "potvrdenie", "doklad"] },
  interview: { label: "Pohovor", general: [{ key: "domain", value: "Job interview" }, { key: "setting", value: "Candidate and recruiter speaking face to face" }], terms: ["pracovná skúsenosť", "životopis", "pracovná pozícia"] },
  doctor: { label: "Lekár", general: [{ key: "domain", value: "Healthcare appointment" }, { key: "setting", value: "Patient and clinician face to face" }], terms: ["alergia", "dávkovanie", "diagnóza", "vyšetrenie"] },
  hotel: { label: "Hotel", general: [{ key: "domain", value: "Hotel reception" }, { key: "setting", value: "Guest and receptionist face to face" }], terms: ["rezervácia", "check-in", "check-out", "izba"] },
  administration: { label: "Administratíva", general: [{ key: "domain", value: "Business administration" }, { key: "setting", value: "Document and process discussion" }], terms: ["faktúra", "objednávka", "zmluva", "termín"] },
  cnc: { label: "CNC", general: [{ key: "domain", value: "CNC machining and manufacturing" }, { key: "setting", value: "Machine operator and technician face to face" }], terms: ["CNC", "G-code", "M-code", "CAD", "CAM", "vreteno", "obrobok"], translation_terms: [{ source: "CNC", target: "CNC" }, { source: "CAD", target: "CAD" }, { source: "CAM", target: "CAM" }] },
});
function contextFor(id) {
  const p = PROFILES[id]; if (!p) return null;
  return { general: p.general, terms: p.terms, ...(p.translation_terms ? { translation_terms: p.translation_terms } : {}) };
}
module.exports = { PROFILES, contextFor };
