/** Bounded fixture waits; listeners belong only to this one expected socket event. */
export function waitForSocketEvent(socket, event, { timeoutMs = 5000, select = (...args) => args[0], rejectEvents = [] } = {}) {
  return new Promise((resolve, reject) => {
    let timer
    const unexpected = rejectEvents.map(name => [name, () => settle(new Error(`Unexpected socket ${name} before ${event}`))])
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener(event, expected)
      if (event !== 'error') socket.removeListener('error', failed)
      if (event !== 'close') socket.removeListener('close', closed)
      for (const [name, listener] of unexpected) socket.removeListener(name, listener)
    }
    const settle = (error, value) => { cleanup(); if (error) reject(error); else resolve(value) }
    const expected = (...args) => {
      try { settle(undefined, select(...args)) } catch (error) { settle(error) }
    }
    const failed = error => settle(error)
    const closed = () => settle(new Error(`Socket closed before ${event}`))
    socket.once(event, expected)
    if (event !== 'error') socket.once('error', failed)
    if (event !== 'close') socket.once('close', closed)
    for (const [name, listener] of unexpected) socket.once(name, listener)
    timer = setTimeout(() => settle(new Error(`Socket ${event} exceeded its fixture budget`)), timeoutMs)
  })
}
