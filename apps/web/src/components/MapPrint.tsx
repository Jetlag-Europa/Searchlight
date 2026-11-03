// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck This should not be edited
import "leaflet-easyprint";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";

// easyPrint hides each of hideClasses during a print, and throws on a class
// with nothing in the page, ending the print before its image. leaflet-draw's
// toolbar only exists while a polygon is drawn, so skip what isn't there.
L.Control.EasyPrint.prototype._toggleClasses = function (classes, show) {
    classes.forEach((name) => {
        const element = document.getElementsByClassName(name)[0];
        if (element) element.style.display = show ? "block" : "none";
    });
};

export const MapPrint = (props) => {
    const map = useMap();

    useEffect(() => {
        const control = L.easyPrint({
            ...props,
        });
        map.addControl(control);
        return () => {
            map.removeControl(control);
        };
    }, [map]);

    return null;
};
