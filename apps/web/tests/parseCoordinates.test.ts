import { describe, expect, it } from "vitest";

import { parseCoordinatesFromText } from "@/components/LatLngPicker";

const none = { lat: null, lng: null };

describe("parseCoordinatesFromText", () => {
    it("reads a decimal pair", () => {
        expect(parseCoordinatesFromText("47.3769, 8.5417")).toEqual({
            lat: 47.3769,
            lng: 8.5417,
        });
        expect(parseCoordinatesFromText("-33.8688,151.2093")).toEqual({
            lat: -33.8688,
            lng: 151.2093,
        });
    });

    it("reads decimal commas", () => {
        expect(parseCoordinatesFromText("37,7749, -122,4194")).toEqual({
            lat: 37.7749,
            lng: -122.4194,
        });
    });

    it("reads degrees, minutes and seconds", () => {
        const { lat, lng } = parseCoordinatesFromText(
            `37°46'26"N, 122°25'10"W`,
        );
        expect(lat).toBeCloseTo(37.77389, 4);
        expect(lng).toBeCloseTo(-122.41944, 4);
    });

    it("reads decimal degrees with directions", () => {
        expect(parseCoordinatesFromText("48.89607° S, 9.09885° W")).toEqual({
            lat: -48.89607,
            lng: -9.09885,
        });
    });

    it("reads the coordinates in a Google Maps link", () => {
        expect(
            parseCoordinatesFromText(
                "https://www.google.com/maps/place/Z%C3%BCrich/@47.3769,8.5417,13z/data=!3m1!4b1",
            ),
        ).toEqual({ lat: 47.3769, lng: 8.5417 });
        expect(
            parseCoordinatesFromText(
                "https://maps.google.com/?q=47.3769,8.5417",
            ),
        ).toEqual({ lat: 47.3769, lng: 8.5417 });
    });

    it("doesn't take a single number for a pair", () => {
        // Pasting one number into a latitude or longitude field must paste as
        // usual rather than set both.
        expect(parseCoordinatesFromText("47.5")).toEqual(none);
        expect(parseCoordinatesFromText("-8.2")).toEqual(none);
        expect(parseCoordinatesFromText("47,5")).toEqual(none);
        expect(parseCoordinatesFromText("47")).toEqual(none);
    });

    it("finds nothing in text without a pair", () => {
        expect(parseCoordinatesFromText("")).toEqual(none);
        expect(parseCoordinatesFromText("Zurich main station")).toEqual(none);
        // Space-separated numbers aren't read as a pair.
        expect(parseCoordinatesFromText("47.5 8.2")).toEqual(none);
    });
});
