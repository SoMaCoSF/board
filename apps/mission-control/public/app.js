// Mission control: reads /api/activity and renders it. No state but the last
// snapshot; lease countdowns tick from the snapshot's own times.
const $ = (id) => document.getElementById(id)

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c])

function rel(iso) {
  if (!iso) return '—'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function actorName(actor) {
  return actor.via ? `${actor.name} via ${actor.via}` : actor.name
}

let leaseUntil = new Map()

function renderTasks(tasks) {
  leaseUntil = new Map()
  const groups = [
    ['Claimed', tasks.filter((t) => t.state === 'claimed')],
    ['Ready', tasks.filter((t) => t.state === 'ready')],
    ['Waiting', tasks.filter((t) => t.state === 'waiting')],
    ['Blocked', tasks.filter((t) => t.state === 'blocked')],
    ['Finished', tasks.filter((t) => ['completed', 'failed', 'canceled'].includes(t.state))],
  ]
  const parts = []
  for (const [label, rows] of groups) {
    if (!rows.length) continue
    parts.push(`<div class="group-label">${label} · ${rows.length}</div>`)
    for (const t of rows) {
      if (t.leaseUntil) leaseUntil.set(t.id, t.leaseUntil)
      const meta = []
      meta.push(`#${esc(t.channel)}`)
      if (t.holder) meta.push(`held by ${esc(t.holder)}`)
      if (t.assignedFor) meta.push(`for ${esc(t.assignedFor)}`)
      if (t.needs.length) meta.push(`needs ${t.needs.map((n) => `#${esc(n)}`).join(', ')}`)
      if (t.replies) meta.push(`${t.replies} replies`)
      if (t.outcome) meta.push(esc(t.outcome))
      const labels = Object.entries(t.labels || {})
        .map(([k, v]) => `<span class="label-chip">${esc(k)}=${esc(v)}</span>`)
        .join(' ')
      parts.push(
        `<div class="task">` +
          `<span class="id">#${esc(t.id)}</span>` +
          `<span class="body"><span class="text">${esc(t.text)}</span>` +
          `<span class="meta">${meta.join(' · ')} ${labels}</span></span>` +
          `<span class="pill ${esc(t.state)}">${esc(t.state)}</span>` +
          (t.leaseUntil ? `<span class="lease" data-lease="${esc(t.id)}"></span>` : '') +
          `</div>`,
      )
    }
  }
  $('tasks').innerHTML = parts.length ? parts.join('') : '<div class="empty">No tasks on this board.</div>'
  tickLeases()
}

function tickLeases() {
  for (const [id, until] of leaseUntil) {
    const el = document.querySelector(`[data-lease="${CSS.escape(id)}"]`)
    if (!el) continue
    const seconds = Math.round((new Date(until).getTime() - Date.now()) / 1000)
    if (seconds <= 0) {
      el.textContent = 'lease over'
      el.classList.add('over')
    } else if (seconds < 3600) {
      el.textContent = `lease ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
    } else {
      el.textContent = `lease ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    }
  }
}

function renderActors(actors) {
  $('actors').innerHTML = actors.length
    ? actors
        .map(
          (a) =>
            `<div class="row"><span>${esc(actorName(a))} <span class="sub">${esc(a.kind)}${a.platform ? ` · ${esc(a.platform)}` : ''}${a.verified ? ' · verified' : ''}${a.activeClaims ? ` · holds ${a.activeClaims}` : ''}</span></span>` +
            `<span class="when">${a.lastActiveAt ? rel(a.lastActiveAt) : 'not seen'}</span></div>`,
        )
        .join('')
    : '<div class="empty">No actors seen yet.</div>'
}

function renderChannels(channels) {
  $('channels').innerHTML = channels.length
    ? channels
        .map(
          (c) =>
            `<div class="row"><span>${esc(c.path)}</span><span class="sub">${c.messages} messages · ${c.threads} threads</span></div>`,
        )
        .join('')
    : '<div class="empty">No channels yet.</div>'
}

function renderEvents(events) {
  $('events').innerHTML = events.length
    ? events
        .map((e) => {
          const decision = e.decision
            ? `<div class="decision">Routing decision: <strong>${esc(e.decision.choice)}</strong>` +
              (e.decision.confidence != null ? ` · confidence ${e.decision.confidence.toFixed(2)}` : '') +
              ` · by ${esc(e.decision.backend || 'jev')} — <a href="https://jevie.ai" target="_blank" rel="noreferrer">jevie.ai</a></div>`
            : ''
          return (
            `<div class="event"><span class="when">${rel(e.at)}</span>${esc(e.summary)}` +
            (e.channel ? ` <span class="chan">#${esc(e.channel)}</span>` : '') +
            decision +
            `</div>`
          )
        })
        .join('')
    : '<div class="empty">No events in this snapshot. A board that cannot read its feed across channels shows tasks and channels without one.</div>'

  const decisions = events.filter((e) => e.decision)
  $('routing-panel').hidden = decisions.length === 0
  if (decisions.length) {
    $('routing').innerHTML = decisions
      .map(
        (e) =>
          `<div class="row"><span>${esc(e.decision.choice)} <span class="sub">in #${esc(e.channel || '')}</span></span>` +
          `<span class="when">${e.decision.confidence != null ? e.decision.confidence.toFixed(2) : ''} · ${esc(e.decision.backend || 'jev')}</span></div>`,
      )
      .join('')
  }
}

function render(snapshot) {
  $('board-name').textContent = snapshot.boardName || ''
  $('stats').innerHTML = [
    [snapshot.counts.channels, 'channels'],
    [snapshot.counts.openTasks, 'open tasks'],
    [snapshot.counts.claimed, 'claimed'],
    [snapshot.counts.actors, 'agents & people'],
  ]
    .map(([n, k]) => `<div class="stat"><div class="n">${n}</div><div class="k">${k}</div></div>`)
    .join('')
  renderTasks(snapshot.tasks)
  renderActors(snapshot.actors)
  renderChannels(snapshot.channels)
  renderEvents(snapshot.events)
  $('generated').textContent = `Snapshot ${new Date(snapshot.generatedAt).toLocaleTimeString()} · refreshes every 20s`
}

async function load() {
  try {
    const response = await fetch('/api/activity', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`activity answered ${response.status}`)
    render(await response.json())
  } catch (error) {
    $('generated').textContent = String(error)
  }
}

load()
setInterval(load, 20_000)
setInterval(tickLeases, 1_000)
