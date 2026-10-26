"use strict";
const LocalHistory = (() => {
  let database;
  async function open() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("soniox-text-history", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("conversations", { keyPath: "id" });
        store.createIndex("user", "user");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("História nie je dostupná."));
      request.onblocked = () => reject(new Error("Zatvor ostatné okná prekladača."));
    });
    database.onversionchange = () => { database.close(); database = null; };
    return database;
  }
  async function operation(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("conversations", mode), store = tx.objectStore("conversations");
      let result;
      try { const request = fn(store); request.onsuccess = () => { result = request.result; }; }
      catch (err) { tx.abort(); reject(err); return; }
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(new Error("Históriu sa nepodarilo uložiť alebo načítať.")); tx.onabort = () => reject(new Error("Ukladanie histórie bolo prerušené."));
    });
  }
  return {
    async save(user, items, languages) {
      if (!user || typeof user !== "string") throw new Error("Najprv sa prihlás.");
      const all = await this.list(user);
      if (all.length >= 100) throw new Error("História má 100 rozhovorov. Najprv niektorý vymaž.");
      // Explicit whitelist: no audio buffers, credentials or provider metadata.
      const clean = items.map(i => ({
        id: i.id, source_language: i.source_language, target_language: i.target_language,
        source_text: i.source_text, translated_text: i.translated_text,
        is_final: Boolean(i.is_final), audio_status: i.audio_status || "text_only",
      }));
      return operation("readwrite", s => s.add({ id: crypto.randomUUID(), user, created_at: new Date().toISOString(), languages, items: clean }));
    },
    async list(user) { if (!user || typeof user !== "string") return []; return (await operation("readonly", s => s.index("user").getAll(user))).sort((a,b) => b.created_at.localeCompare(a.created_at)); },
    async remove(user, id) {
      if (!user || typeof user !== "string") throw new Error("Najprv sa prihlás.");
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("conversations", "readwrite"), store = tx.objectStore("conversations");
        const request = store.get(id);
        request.onsuccess = () => { if (request.result?.user === user) store.delete(id); };
        tx.oncomplete = resolve; tx.onerror = () => reject(new Error("Vymazanie zlyhalo."));
      });
    },
  };
})();
