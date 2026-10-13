import * as turf from "@turf/turf";
import type { Evaluator } from "@searchlight/shared";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GeoUtils from "@/maps/geo-utils";

const mockArcBufferToPoint = vi.fn();

vi.mock("@/maps/geo-utils", async (importActual) => {
  const actual = await importActual<typeof GeoUtils>();
  return {
    ...actual,
    arcBufferToPoint: (...args: unknown[]) => mockArcBufferToPoint(...args),
  };
});

import { determineMeasuringGeometry, evaluateMeasuringOperator } from "@/maps/questions/operators/measuring";

describe("evaluateMeasuringOperator regression tests", () => {
  const mapGeoData = turf.featureCollection([turf.bboxPolygon([0, 0, 10, 10])]);
  const bufferPolygon = turf.bboxPolygon([2, 2, 6, 6]);
  const insidePoint = turf.point([4, 4]);
  const outsidePoint = turf.point([8, 8]);

  const evaluator: Evaluator = {
    operator: "nearest-feature-distance",
    source: {
      kind: "dataset",
      datasetId: "pois",
    },
  };

  let datasets: { pois: { kind: string; features: FeatureCollection } };

  beforeEach(() => {
    vi.clearAllMocks();
    datasets = { pois: { kind: "inline", features: turf.featureCollection([turf.point([4, 4])]) } };
  });

  it("awaits async buffer and retains closer points when hiderCloser is true", async () => {
    mockArcBufferToPoint.mockImplementation(async () => {
      await Promise.resolve();
      return bufferPolygon;
    });

    const result = (await evaluateMeasuringOperator({
      evaluator,
      datasets,
      data: { lat: 4, lng: 4, hiderCloser: true },
      mapGeoData,
    })) as Feature<Polygon | MultiPolygon> | null;

    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(turf.booleanPointInPolygon(insidePoint, result!)).toBe(true);
    expect(turf.booleanPointInPolygon(outsidePoint, result!)).toBe(false);
  });

  it("awaits async buffer and retains farther points when hiderCloser is false", async () => {
    mockArcBufferToPoint.mockImplementation(async () => {
      await Promise.resolve();
      return bufferPolygon;
    });

    const result = (await evaluateMeasuringOperator({
      evaluator,
      datasets,
      data: { lat: 4, lng: 4, hiderCloser: false },
      mapGeoData,
    })) as Feature<Polygon | MultiPolygon> | null;

    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(turf.booleanPointInPolygon(insidePoint, result!)).toBe(false);
    expect(turf.booleanPointInPolygon(outsidePoint, result!)).toBe(true);
  });

  it("propagates rejected buffers and permits the same question to retry", async () => {
    mockArcBufferToPoint.mockRejectedValue(new Error("Buffer calculation failed"));

    await expect(
      evaluateMeasuringOperator({
        evaluator,
        datasets,
        data: { lat: 4, lng: 4, hiderCloser: true },
        mapGeoData,
      }),
    ).rejects.toThrow("Buffer calculation failed");
    mockArcBufferToPoint.mockResolvedValue(bufferPolygon);
    const recovered = await evaluateMeasuringOperator({
      evaluator, datasets, data: { lat: 4, lng: 4, hiderCloser: true }, mapGeoData,
    });
    expect(turf.booleanPointInPolygon(insidePoint, recovered as Feature<Polygon | MultiPolygon>)).toBe(true);
    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(2);
  });

  it("shares in-flight and completed geometry across planning, opposite answers, and narrowed maps", async () => {
    mockArcBufferToPoint.mockImplementation(async () => {
      await Promise.resolve();
      return bufferPolygon;
    });
    const params = { evaluator, datasets, data: { lat: 4, lng: 4 } };
    const [preview, closer, farther] = await Promise.all([
      determineMeasuringGeometry(params),
      evaluateMeasuringOperator({ ...params, mapGeoData }),
      evaluateMeasuringOperator({
        ...params, data: { ...params.data, hiderCloser: false },
        mapGeoData: turf.featureCollection([turf.bboxPolygon([1, 1, 9, 9])]),
      }),
    ]);
    expect(turf.booleanPointInPolygon(insidePoint, preview!)).toBe(true);
    expect(turf.booleanPointInPolygon(insidePoint, closer as Feature<Polygon | MultiPolygon>)).toBe(true);
    expect(turf.booleanPointInPolygon(insidePoint, farther as Feature<Polygon | MultiPolygon>)).toBe(false);
    expect(turf.booleanPointInPolygon(outsidePoint, farther as Feature<Polygon | MultiPolygon>)).toBe(true);
    await evaluateMeasuringOperator({ ...params, mapGeoData });
    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(1);
  });

  it("asks the worker for a buffer exact over the map's rounded-out bbox, superseded by the question's next position", async () => {
    mockArcBufferToPoint.mockResolvedValue(bufferPolygon);
    const map = turf.featureCollection([turf.bboxPolygon([4.31, 50.82, 4.47, 50.91])]);
    await evaluateMeasuringOperator({
      evaluator, datasets, data: { lat: 4, lng: 4 }, mapGeoData: map, requestKey: "question:3",
    });
    const [, lat, lng, options] = mockArcBufferToPoint.mock.calls[0];
    expect([lat, lng]).toEqual([4, 4]);
    expect(options.supersede).toBe("question:3");
    const [west, south, east, north] = options.within;
    expect(west).toBeCloseTo(4.3, 9);
    expect(south).toBeCloseTo(50.8, 9);
    expect(east).toBeCloseTo(4.5, 9);
    expect(north).toBeCloseTo(50.95, 9);
    expect(west).toBeLessThanOrEqual(4.31);
    expect(north).toBeGreaterThanOrEqual(50.91);
    // A wider map needs a buffer exact over more of it.
    await evaluateMeasuringOperator({ evaluator, datasets, data: { lat: 4, lng: 4 }, mapGeoData });
    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(2);
    expect(mockArcBufferToPoint.mock.calls[1][3].within).toEqual([0, 0, 10, 10]);
  });

  it("treats an empty buffer as no feature within the seeker's distance of the map", async () => {
    mockArcBufferToPoint.mockResolvedValue(turf.multiPolygon([]));
    const closer = await evaluateMeasuringOperator({
      evaluator, datasets, data: { lat: 4, lng: 4, hiderCloser: true }, mapGeoData,
    });
    expect(closer).toEqual(turf.featureCollection([]));
    const farther = await evaluateMeasuringOperator({
      evaluator, datasets, data: { lat: 4, lng: 4, hiderCloser: false }, mapGeoData,
    });
    expect(farther).toBe(mapGeoData);
  });

  it("invalidates when position, dataset data, or compiled revision identity changes", async () => {
    mockArcBufferToPoint.mockResolvedValue(bufferPolygon);
    const params = { evaluator, datasets, data: { lat: 4, lng: 4 } };
    await determineMeasuringGeometry(params);
    await determineMeasuringGeometry({ ...params, data: { lat: 4.1, lng: 4 } });
    datasets.pois.features = turf.featureCollection([turf.point([5, 5])]);
    await determineMeasuringGeometry(params);
    await determineMeasuringGeometry({ ...params, datasets: { ...datasets } });
    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(4);
  });

  it("bounds retained drag positions while retaining the most recent result", async () => {
    mockArcBufferToPoint.mockResolvedValue(bufferPolygon);
    const params = { evaluator, datasets, data: { lat: 4, lng: 4 } };
    for (let position = 0; position < 100; position++) {
      await determineMeasuringGeometry({ ...params, data: { lat: 4 + position / 1000, lng: 4 } });
    }
    await determineMeasuringGeometry({ ...params, data: { lat: 4.099, lng: 4 } });
    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(100);
    await determineMeasuringGeometry(params);
    expect(mockArcBufferToPoint).toHaveBeenCalledTimes(101);
  });
});
