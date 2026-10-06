// Node tests for the browser logic module web/js/seq.js.
// Run: node tests/test_frontend_logic.mjs
import assert from "node:assert/strict";
import { RequestSequencer, SequenceNavigator, PreloadGate, retryingFetch }
  from "../web/js/seq.js";

let passed = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("ok -", name); })
    .catch(err => { console.error("FAIL -", name); throw err; });
};

await test("out-of-order pagination: stale response is dropped", async () => {
  const seq = new RequestSequencer();
  const slow = seq.next();                 // request 1 (will resolve last)
  const fast = seq.next();                 // request 2 (resolves first)
  const committed = [];
  const respond = (id, payload) => { if (seq.isCurrent(id)) committed.push(payload); };
  respond(fast, "page-for-filter-B");      // newer lands first
  respond(slow, "page-for-filter-A");      // stale lands late -> dropped
  assert.deepEqual(committed, ["page-for-filter-B"]);
});

await test("lightbox snapshot: delisted middle item is skipped, positions stable", () => {
  const nav = new SequenceNavigator([10, 11, 12, 13], 0);
  nav.markGone(11);                        // delisted while browsing
  assert.equal(nav.currentId(), 10);
  assert.equal(nav.next(), 12);            // skips 11, lands on 12
  assert.equal(nav.ids.length, 4);         // snapshot length unchanged
  assert.equal(nav.prev(), 10);            // back skips 11 again
});

await test("lightbox: current item delisted -> tombstone, arrows still move", () => {
  const nav = new SequenceNavigator([10, 11, 12], 1);
  nav.markGone(11);                        // current slide is gone
  assert.equal(nav.currentId(), 11);       // position kept (tombstone slide)
  assert.equal(nav.next(), 12);            // leave the tombstone forward
  assert.equal(nav.prev(), 10);            // gone item is skipped on the way
                                           // back: no repeat-jump to it
  assert.equal(nav.prev(), null);
  assert.equal(nav.currentId(), 10);
});

await test("lightbox: hard stop at sequence ends, never wraps or repeats", () => {
  const nav = new SequenceNavigator([10, 11], 0);
  assert.equal(nav.prev(), null);          // left at first item: nothing
  assert.equal(nav.currentId(), 10);       // index did not move
  assert.equal(nav.next(), 11);
  assert.equal(nav.next(), null);          // right at last item: nothing
  assert.equal(nav.currentId(), 11);       // no jump back to 10
});

await test("lightbox: all remaining items gone -> navigation returns null", () => {
  const nav = new SequenceNavigator([10, 11, 12], 0);
  nav.markGone(11); nav.markGone(12);
  assert.equal(nav.next(), null);
  assert.equal(nav.hasNext(), false);
  assert.equal(nav.currentId(), 10);
});

await test("preload identity: late image from old task cannot commit", () => {
  const gate = new PreloadGate();
  const stale = gate.begin(1, "v1");       // user starts loading photo 1
  const fresh = gate.begin(2, "v1");       // user quickly moves to photo 2
  const shown = [];
  // stale task resolves LAST but must lose
  assert.equal(gate.commit(fresh, () => shown.push("photo2-title")), true);
  assert.equal(gate.commit(stale, () => shown.push("photo1-title")), false);
  assert.deepEqual(shown, ["photo2-title"]); // title never overwritten
});

await test("preload identity: same photo, regenerated variant is a new task", () => {
  const gate = new PreloadGate();
  const oldVariant = gate.begin(1, "/media/1/large/v1.jpg");
  const newVariant = gate.begin(1, "/media/1/large/v2.jpg");
  assert.notEqual(oldVariant.variantId, newVariant.variantId);
  assert.equal(gate.commit(oldVariant, () => {}), false);
  assert.equal(gate.commit(newVariant, () => {}), true);
});

await test("retryingFetch: network interruption retried with backoff", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new TypeError("fetch failed");  // connection dropped
    return { status: 200 };
  };
  const t0 = Date.now();
  const res = await retryingFetch(flaky, "/api/photos", {}, { retries: 3, baseMs: 10 });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.ok(Date.now() - t0 >= 25);        // 10ms + 20ms backoff happened
});

await test("retryingFetch: 4xx is definitive, never retried", async () => {
  let calls = 0;
  const gone = async () => { calls++; return { status: 410 }; };
  const res = await retryingFetch(gone, "/api/photos/9/public", {}, { retries: 3, baseMs: 1 });
  assert.equal(res.status, 410);
  assert.equal(calls, 1);
});

await test("retryingFetch: persistent network failure throws after retries", async () => {
  let calls = 0;
  const down = async () => { calls++; throw new TypeError("fetch failed"); };
  await assert.rejects(
    retryingFetch(down, "/api/photos", {}, { retries: 2, baseMs: 1 }),
    /fetch failed/);
  assert.equal(calls, 3);                  // initial + 2 retries
});

console.log(`\n${passed} frontend logic tests passed`);
