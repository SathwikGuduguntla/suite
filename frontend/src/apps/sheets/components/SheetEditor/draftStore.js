// Local, per-user, per-sheet draft store. Survives a hard refresh (where
// onBeforeUnmount never fires). Never logs cell contents.
const PREFIX = 'sheets:draft:'
// [sheet, cell] pair, so A1 on two tabs never collides.
const entryKey = (sheetName, cell) => JSON.stringify([sheetName, cell])

export function createDraftStore({ getUser, getSheetId, getStorage = () => window.localStorage }) {
  const storage = () => { try { return getStorage() } catch { return null } }

  function key() {
    const user = getUser()
    const id = getSheetId()
    if (!user || !id || id === 'new') return null
    return `${PREFIX}${encodeURIComponent(user)}:${id}`
  }

  function read() {
    const k = key(), s = storage()
    if (!k || !s) return null
    try {
      const parsed = JSON.parse(s.getItem(k))
      return parsed && typeof parsed === 'object' && parsed.cells ? parsed : null
    } catch { return null }
  }

  function write(cells) {
    const k = key(), s = storage()
    if (!k || !s) return
    try {
      if (!Object.keys(cells).length) s.removeItem(k)
      else s.setItem(k, JSON.stringify({ cells, ts: Date.now() }))
    } catch { /* private mode / quota: never break editing for storage */ }
  }

  // Pre-fix drafts were keyed by sheet id only and may hold another
  // account's content. Drop them.
  function purgeLegacy() {
    const s = storage(), id = getSheetId()
    if (!s || !id || id === 'new') return
    try { s.removeItem(`${PREFIX}${id}`) } catch { /* ignore */ }
  }

  // Called on every keystroke. `base` is the committed value at the time
  // editing started; it is kept from the first keystroke onward.
  function save(cell, value, sheetName, base) {
    if (!cell || !key()) return
    const cells = read()?.cells || {}
    const k = entryKey(sheetName, cell)
    cells[k] = { sheet: sheetName, cell, value, base: cells[k] ? cells[k].base : base }
    write(cells)
  }

  // Escape / rejected commit: the user's pending value must not resurrect.
  function clearCell(cell, sheetName) {
    const draft = read()
    if (!draft) return
    delete draft.cells[entryKey(sheetName, cell)]
    write(draft.cells)
  }

  // After a confirmed server save: drop entries the engine now matches,
  // keep newer keystrokes typed while the request was in flight.
  function clearSaved(getCell) {
    const draft = read()
    if (!draft) return
    const remaining = {}
    for (const [k, e] of Object.entries(draft.cells)) {
      if (getCell(e.cell, e.sheet) !== e.value) remaining[k] = e
    }
    write(remaining)
  }

  // Returns the number of cells restored. Never restores for read-only
  // users, over data that changed since the draft began, into protected
  // cells, or into sheets that no longer exist. Everything else is discarded.
  function restore({ getCell, setCell, canRestore, isBlocked, sheetExists }) {
    purgeLegacy()
    const draft = read()
    if (!draft) return 0
    if (!canRestore()) { write({}); return 0 }
    const kept = {}
    let count = 0
    for (const [k, e] of Object.entries(draft.cells)) {
      if (!sheetExists(e.sheet)) continue
      const current = getCell(e.cell, e.sheet)
      if (current === e.value) continue
      if (e.base !== undefined && current !== e.base) continue
      if (isBlocked(e.cell, e.sheet)) continue
      setCell(e.cell, e.value, e.sheet)
      kept[k] = e
      count++
    }
    write(kept)   // autosave clears these via clearSaved once persisted
    return count
  }

  return { save, clearCell, clearSaved, restore, read }
}