import { describe, expect, it } from "vitest";
import { diffQuestionLists } from "./question-history.js";

const radius = (key: number, data: Record<string, unknown> = {}) => ({
  id: "radius",
  key,
  data: { lat: 52.37, lng: 4.89, radius: 2, unit: "kilometers", within: true, drag: true, collapsed: false, ...data },
});

// The next double up: what a one-ulp drift looks like.
const nextUp = (x: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
};

const K1 = 0.12345678901234567;
const K2 = 0.7654321098765432;
const K3 = 0.3141592653589793;

describe("diffQuestionLists", () => {
  it("lists an added question with its position", () => {
    const diff = diffQuestionLists([radius(K1)], [radius(K1), radius(K2), { id: "matching", key: K3, data: {} }]);
    expect(diff.reordered).toBe(false);
    expect(diff.prevOrder).toBeUndefined();
    expect(diff.changes).toEqual([
      expect.objectContaining({ kind: "added", key: K2, id: "radius", index: 1, typeIndex: 2 }),
      expect.objectContaining({ kind: "added", key: K3, id: "matching", index: 2, typeIndex: 1 }),
    ]);
  });

  it("lists the fields a change touched, with their old and new values", () => {
    const diff = diffQuestionLists(
      [radius(K1, { name: "Airport" })],
      [radius(K1, { name: "Airport", within: false, lat: 52.38 })],
    );
    expect(diff.changes).toHaveLength(1);
    const [change] = diff.changes;
    expect(change).toMatchObject({ kind: "changed", key: K1, index: 0, typeIndex: 1 });
    expect(change.fields?.sort()).toEqual(["lat", "within"]);
    // Only the changed fields, the name and the whole pin.
    expect(change.before).toEqual({ within: true, lat: 52.37, lng: 4.89, name: "Airport" });
    expect(change.after).toEqual({ within: false, lat: 52.38, lng: 4.89, name: "Airport" });
  });

  it("ignores a change that only folds a card", () => {
    const diff = diffQuestionLists([radius(K1)], [radius(K1, { collapsed: true })]);
    expect(diff).toEqual({ changes: [], reordered: false });
  });

  it("doesn't see a key or a coordinate one ulp off as a change", () => {
    const lat = 52.123456789012345;
    const diff = diffQuestionLists([radius(K1, { lat })], [radius(nextUp(K1), { lat: nextUp(lat) })]);
    expect(diff).toEqual({ changes: [], reordered: false });
  });

  it("gives a removed question in full, and the order before", () => {
    const geo = { type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: {} }] };
    const matching = { id: "matching", key: K2, data: { type: "custom-zone", geo, same: true } };
    const diff = diffQuestionLists([radius(K1), matching, radius(K3)], [radius(K1), radius(K3)]);
    expect(diff.changes).toEqual([
      { kind: "removed", key: K2, id: "matching", index: 1, typeIndex: 1, question: matching },
    ]);
    expect(diff.prevOrder).toEqual([K1, K2, K3]);
    expect(diff.reordered).toBe(false);
  });

  it("omits geo and places from changes, but keeps them in a removed question", () => {
    const geo = { type: "FeatureCollection", features: [] };
    const places = [{ type: "Feature", geometry: { type: "Point", coordinates: [4, 52] }, properties: { name: "A" } }];
    const tentacle = (data: Record<string, unknown>) => ({
      id: "tentacles",
      key: K2,
      data: { locationType: "custom", places, radius: 15, ...data },
    });
    const matching = (data: Record<string, unknown>) => ({ id: "matching", key: K1, data: { type: "custom-zone", geo, ...data } });

    const added = diffQuestionLists([], [matching({})]);
    expect(added.changes[0].after).toEqual({ type: "custom-zone", geo: { omitted: true } });

    const changed = diffQuestionLists([matching({}), tentacle({})], [matching({ geo: { ...geo, features: [1] } }), tentacle({ places: [] })]);
    expect(changed.changes.map((c) => c.fields)).toEqual([["geo"], ["places"]]);
    expect(changed.changes[0].before).toEqual({ geo: { omitted: true } });
    expect(changed.changes[1].after).toEqual({ places: { omitted: true } });

    const removed = diffQuestionLists([tentacle({})], []);
    expect(removed.changes[0].question).toEqual(tentacle({}));
  });

  it("notices a new order of the questions kept", () => {
    const diff = diffQuestionLists([radius(K1), radius(K2), radius(K3)], [radius(K2), radius(K1), radius(K3)]);
    expect(diff).toEqual({ changes: [], reordered: true });
  });

  it("doesn't call an add or a removal a reorder", () => {
    expect(diffQuestionLists([radius(K1), radius(K3)], [radius(K2), radius(K1), radius(K3)]).reordered).toBe(false);
    expect(diffQuestionLists([radius(K1), radius(K2), radius(K3)], [radius(K1), radius(K3)]).reordered).toBe(false);
  });

  it("pairs exact keys before near ones", () => {
    // Two questions one ulp apart, and the second drifts once more: it is
    // near both, but K1 has its exact match further down.
    const twin = nextUp(K1);
    const diff = diffQuestionLists(
      [radius(K1, { radius: 2 }), radius(twin, { radius: 1 })],
      [radius(nextUp(twin), { radius: 1 }), radius(K1, { radius: 2 })],
    );
    expect(diff).toEqual({ changes: [], reordered: true });
  });

  it("sees a key that changed type as a removal and an add", () => {
    const diff = diffQuestionLists([radius(K1)], [{ id: "matching", key: K1, data: {} }]);
    expect(diff.changes.map((c) => c.kind)).toEqual(["added", "removed"]);
  });

  it("skips malformed entries without throwing", () => {
    const junk = [null, 3, "x", [], { id: "radius" }, { key: "1", data: {} }, { key: Number.NaN }];
    expect(diffQuestionLists(junk, [...junk, radius(K1)]).changes).toEqual([
      expect.objectContaining({ kind: "added", key: K1, index: 0 }),
    ]);
    expect(diffQuestionLists(null as unknown as unknown[], undefined as unknown as unknown[])).toEqual({
      changes: [],
      reordered: false,
    });
    // A question without data, or with an odd id, still diffs.
    const odd = diffQuestionLists([{ key: K1 }], [{ key: K1, id: 5, data: { a: 1 } }]);
    expect(odd.changes).toEqual([expect.objectContaining({ kind: "changed", id: "unknown", fields: ["a"] })]);
  });
});
