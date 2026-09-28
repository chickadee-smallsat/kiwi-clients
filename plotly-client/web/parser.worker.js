// Parses SSE batches off the UI thread and enriches each sample with its
// session time and derived vector quantities.
//
// Messages posted back:
//   { type: 'samples', host_ms, items: [...] }
//   { type: 'reset', session }   – the board rebooted; later items start a new session

import { decodeBatch, isVectorSensor, magnitude, anglesDeg, SessionClock } from './kiwi-protocol.js';

const clock = new SessionClock();

self.onmessage = (ev) => {
  const host_ms = Date.now();
  let items = [];

  for (const s of decodeBatch(ev.data)) {
    const { t_s, reset } = clock.update(s.t_us);
    if (reset) {
      if (items.length) self.postMessage({ type: 'samples', host_ms, items });
      items = [];
      self.postMessage({ type: 'reset', session: clock.session });
    }

    const item = { ...s, t_s, session: clock.session };
    if (isVectorSensor(s.sensor)) {
      item.mag = magnitude(s.x, s.y, s.z);
      Object.assign(item, anglesDeg(s.x, s.y, s.z));
    }
    items.push(item);
  }

  if (items.length) self.postMessage({ type: 'samples', host_ms, items });
};
