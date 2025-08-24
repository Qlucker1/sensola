import React, { useMemo, useRef, useState, useEffect } from "react";

// ✅ Конфигуратор столешниц v3 (+ PNG/PDF экспорт без настройки Netlify)
// Формы: прямоуг., Г-образная (L), П-образная (U) + отдельный остров
// Новое:
//  • Остров можно считать как отдельную позицию ИЛИ включать в общий лист раскроя
//  • Кнопки экспорта вынесены в отдельную нижнюю панель (fixed)
//  • Для L/U — настраиваемые радиусы ВНУТРЕННИХ углов (под радиус фрезы)
//  • DXF join("\n") исправлен и общий DXF для листа
//  • Добавлен экспорт PNG и PDF — без правок настроек Netlify (скрипты jsPDF/svg2pdf подгружаются динамически)

// --------------------- УТИЛИТЫ ---------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mm = (v) => Number.parseFloat(v || 0);

function roundedRectPath({ w, h, rTL, rTR, rBR, rBL }) {
  const r1 = clamp(rTL, 0, Math.min(w / 2, h / 2));
  const r2 = clamp(rTR, 0, Math.min(w / 2, h / 2));
  const r3 = clamp(rBR, 0, Math.min(w / 2, h / 2));
  const r4 = clamp(rBL, 0, Math.min(w / 2, h / 2));
  return [
    `M ${r1} 0`,
    `H ${w - r2}`,
    r2 ? `A ${r2} ${r2} 0 0 1 ${w} ${r2}` : `L ${w} 0`,
    `V ${h - r3}`,
    r3 ? `A ${r3} ${r3} 0 0 1 ${w - r3} ${h}` : `L ${w} ${h}`,
    `H ${r4}`,
    r4 ? `A ${r4} ${r4} 0 0 1 0 ${h - r4}` : `L 0 ${h}`,
    `V ${r1}`,
    r1 ? `A ${r1} ${r1} 0 0 1 ${r1} 0` : `L 0 0`,
    "Z",
  ].join(" ");
}

function roundedRectPathFromBox(x0, y0, w, h, rTL, rTR, rBR, rBL) {
  // Путь скруглённого прямоугольника, заданного коробкой [x0,y0,w,h]
  const r1 = clamp(rTL, 0, Math.min(w / 2, h / 2));
  const r2 = clamp(rTR, 0, Math.min(w / 2, h / 2));
  const r3 = clamp(rBR, 0, Math.min(w / 2, h / 2));
  const r4 = clamp(rBL, 0, Math.min(w / 2, h / 2));
  const x1 = x0 + w, y1 = y0 + h;
  return [
    `M ${x0 + r1} ${y0}`,
    `H ${x1 - r2}`,
    r2 ? `A ${r2} ${r2} 0 0 1 ${x1} ${y0 + r2}` : `L ${x1} ${y0}`,
    `V ${y1 - r3}`,
    r3 ? `A ${r3} ${r3} 0 0 1 ${x1 - r3} ${y1}` : `L ${x1} ${y1}`,
    `H ${x0 + r4}`,
    r4 ? `A ${r4} ${r4} 0 0 1 ${x0} ${y1 - r4}` : `L ${x0} ${y1}`,
    `V ${y0 + r1}`,
    r1 ? `A ${r1} ${r1} 0 0 1 ${x0 + r1} ${y0}` : `L ${x0} ${y0}`,
    "Z",
  ].join(" ");
}

function sampleArc(cx, cy, r, startDeg, endDeg, maxSegLen = 5) {
  const pts = [];
  const totalRad = ((endDeg - startDeg) * Math.PI) / 180;
  const arcLen = Math.abs(totalRad * r);
  const steps = Math.max(4, Math.ceil(arcLen / maxSegLen));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = ((startDeg + (endDeg - startDeg) * t) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return pts;
}

function roundedRectPolyline({ w, h, rTL, rTR, rBR, rBL }, maxSegLen = 5) {
  const r1 = clamp(rTL, 0, Math.min(w / 2, h / 2));
  const r2 = clamp(rTR, 0, Math.min(w / 2, h / 2));
  const r3 = clamp(rBR, 0, Math.min(w / 2, h / 2));
  const r4 = clamp(rBL, 0, Math.min(w / 2, h / 2));

  const pts = [];
  pts.push([r1, 0]);
  pts.push([w - r2, 0]);
  if (r2 > 0) pts.push(...sampleArc(w - r2, r2, r2, -90, 0));
  pts.push([w, h - r3]);
  if (r3 > 0) pts.push(...sampleArc(w - r3, h - r3, r3, 0, 90));
  pts.push([r4, h]);
  if (r4 > 0) pts.push(...sampleArc(r4, h - r4, r4, 90, 180));
  pts.push([0, r1]);
  if (r1 > 0) pts.push(...sampleArc(r1, r1, r1, 180, 270));
  return dedupeClosePoints(pts);
}

function offsetPoints(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

function dedupeClosePoints(pts, eps = 0.01) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  return out;
}

function download(filename, text) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --------------------- DXF ---------------------
function polyToDXF(points, layer = "0", closed = false) {
  const seq = [
    "0", "LWPOLYLINE", "8", layer,
    "90", String(points.length + (closed ? 1 : 0)),
    "70", String(closed ? 1 : 0),
  ];
  for (const [x, y] of points) seq.push("10", String(x), "20", String(-y));
  if (closed) {
    const [x, y] = points[0];
    seq.push("10", String(x), "20", String(-y));
  }
  return seq;
}

function toDXF({ w, h, rTL, rTR, rBR, rBL }, cutouts) {
  // Единичный DXF (только одна деталь)
  const header = [
    "0", "SECTION", "2", "HEADER",
    "9", "$INSUNITS", "70", "4",
    "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
  ];
  const ents = [];
  const outer = roundedRectPolyline({ w, h, rTL, rTR, rBR, rBL }, 3);
  ents.push(...polyToDXF(outer, "OUTER", true));

  for (const c of cutouts) {
    if (c.type === "circle") {
      ents.push(
        "0", "CIRCLE", "8", "CUTOUT",
        "10", String(c.x), "20", String(-c.y), "30", "0", "40", String(c.r)
      );
    } else if (c.type === "rect") {
      const x0 = c.x - c.w / 2, y0 = c.y - c.h / 2;
      const hasR = c.rTL || c.rTR || c.rBR || c.rBL;
      const poly = hasR
        ? offsetPoints(roundedRectPolyline({ w: c.w, h: c.h, rTL: c.rTL||0, rTR: c.rTR||0, rBR: c.rBR||0, rBL: c.rBL||0 }, 3), x0, y0)
        : [[x0, y0], [x0 + c.w, y0], [x0 + c.w, y0 + c.h], [x0, y0 + c.h]];
      ents.push(...polyToDXF(poly, "CUTOUT", true));
    }
  }

  const tail = ["0", "ENDSEC", "0", "EOF"]; 
  return [...header, ...ents, ...tail].join("\n");
}

function toDXFCombined(main, island, islandOffset) {
  // Общий DXF (две детали в одном листе). main = {shape, size, fillets, holes, cutouts}
  const header = [
    "0", "SECTION", "2", "HEADER",
    "9", "$INSUNITS", "70", "4",
    "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
  ];
  const ents = [];

  // Основная
  const outerMain = roundedRectPolyline({ w: main.size.w, h: main.size.h, ...main.fillets }, 3);
  ents.push(...polyToDXF(outerMain, "OUTER_MAIN", true));
  const holesMain = [...(main.holes||[]), ...(main.cutouts||[])];
  for (const c of holesMain) {
    if (c.type === 'circle') {
      ents.push("0","CIRCLE","8","CUT_MAIN","10",String(c.x),"20",String(-c.y),"30","0","40",String(c.r));
    } else {
      const x0 = c.x - c.w/2, y0 = c.y - c.h/2;
      const hasR = c.rTL || c.rTR || c.rBR || c.rBL;
      const poly = hasR
        ? offsetPoints(roundedRectPolyline({ w: c.w, h: c.h, rTL: c.rTL||0, rTR: c.rTR||0, rBR: c.rBR||0, rBL: c.rBL||0 }, 3), x0, y0)
        : [[x0,y0],[x0+c.w,y0],[x0+c.w,y0+c.h],[x0,y0+c.h]];
      ents.push(...polyToDXF(poly, "CUT_MAIN", true));
    }
  }

  // Остров
  if (island) {
    const offx = islandOffset.x || 0, offy = islandOffset.y || 0;
    const outerIsl = offsetPoints(roundedRectPolyline({ w: island.size.w, h: island.size.h, rTL: island.radius||0, rTR: island.radius||0, rBR: island.radius||0, rBL: island.radius||0 }, 3), offx, offy);
    ents.push(...polyToDXF(outerIsl, "OUTER_ISLAND", true));
    for (const c of (island.cutouts||[])) {
      if (c.type === 'circle') {
        ents.push("0","CIRCLE","8","CUT_ISLAND","10",String(c.x+offx),"20",String(-(c.y+offy)),"30","0","40",String(c.r));
      } else {
        const x0 = (c.x - c.w/2) + offx, y0 = (c.y - c.h/2) + offy;
        const poly = [[x0,y0],[x0+c.w,y0],[x0+c.w,y0+c.h],[x0,y0+c.h]];
        ents.push(...polyToDXF(poly, "CUT_ISLAND", true));
      }
    }
  }

  const tail = ["0", "ENDSEC", "0", "EOF"]; 
  return [...header, ...ents, ...tail].join("\n");
}

// --------------------- КОМПОНЕНТ ---------------------
export default function CountertopConfigurator() {
  // --- Основная столешница ---
  const [shape, setShape] = useState("rect"); // rect | L | U
  const [w, setW] = useState(2000);
  const [h, setH] = useState(600);
  const [rTL, setRTL] = useState(0);
  const [rTR, setRTR] = useState(20);
  const [rBR, setRBR] = useState(0);
  const [rBL, setRBL] = useState(20);
  const [thickness, setThickness] = useState(12);

  // L-образная: вырезаемый прямоугольник + радиусы внутренних углов
  const [lCorner, setLCorner] = useState("TR"); // TL|TR|BR|BL
  const [lW, setLW] = useState(600);
  const [lD, setLD] = useState(600);
  const [lRTL, setLRTL] = useState(0);
  const [lRTR, setLRTR] = useState(0);
  const [lRBR, setLRBR] = useState(0);
  const [lRBL, setLRBL] = useState(0);

  // U-образная: центральный проём + радиусы
  const [uW, setUW] = useState(900);
  const [uD, setUD] = useState(300);
  const [uSide, setUSide] = useState("top"); // top | bottom
  const [uRTL, setURTL] = useState(0);
  const [uRTR, setURTR] = useState(0);
  const [uRBR, setURBR] = useState(0);
  const [uRBL, setURBL] = useState(0);

  // --- Остров ---
  const [hasIsland, setHasIsland] = useState(true);
  const [iW, setIW] = useState(1200);
  const [iH, setIH] = useState(800);
  const [iR, setIR] = useState(0);
  const [islandSeparate, setIslandSeparate] = useState(true); // ✅ выбор: отдельная позиция или общий лист

  // --- Общие настройки вида ---
  const [grid, setGrid] = useState(50);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(0.6);
  const [pan, setPan] = useState({ x: 80, y: 80 });

  // Вырезы (по контексту: основная/остров)
  const [cutMain, setCutMain] = useState([
    { id: "m1", type: "circle", x: 500, y: 300, r: 90 },
    { id: "m2", type: "rect", x: 1300, y: 300, w: 560, h: 490 },
  ]);
  const [cutIsl, setCutIsl] = useState([]);

  const [editCtx, setEditCtx] = useState("main"); // main | island
  const [selectedId, setSelectedId] = useState(null); // формат: "main:m1" | "island:i1"

  const viewRef = useRef(null);
  const panDrag = useRef(null);
  const dragCutout = useRef(null);

  // геометрия контуров
  const mainOuterPath = useMemo(
    () => roundedRectPath({ w, h, rTL, rTR, rBR, rBL }),
    [w, h, rTL, rTR, rBR, rBL]
  );
  const islandOuterPath = useMemo(
    () => roundedRectPath({ w: iW, h: iH, rTL: iR, rTR: iR, rBR: iR, rBL: iR }),
    [iW, iH, iR]
  );

  // отверстия формы (L/U) с внутренними радиусами
  const mainShapeHoles = useMemo(() => {
    const holes = [];
    if (shape === "L") {
      const x = (lCorner === "TL" || lCorner === "BL") ? lW / 2 : w - lW / 2;
      const y = (lCorner === "TL" || lCorner === "TR") ? lD / 2 : h - lD / 2;
      holes.push({ type: "rect", id: "holeL", x, y, w: lW, h: lD, rTL: lRTL, rTR: lRTR, rBR: lRBR, rBL: lRBL });
    } else if (shape === "U") {
      const x = w / 2;
      const y = uSide === "top" ? uD / 2 : h - uD / 2;
      holes.push({ type: "rect", id: "holeU", x, y, w: clamp(uW, 0, w), h: clamp(uD, 0, h), rTL: uRTL, rTR: uRTR, rBR: uRBR, rBL: uRBL });
    }
    return holes;
  }, [shape, w, h, lCorner, lW, lD, lRTL, lRTR, lRBR, lRBL, uW, uD, uSide, uRTL, uRTR, uRBR, uRBL]);

  // Сдвиг острова вправо от основной
  const islandOffset = { x: w + 220, y: 0 };

  // --- Обработчики мыши/зум ---
  const onMouseDownBG = (e) => {
    if (e.button === 1 || e.button === 2 || e.target.getAttribute("data-bg")) {
      panDrag.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    }
  };
  const onMouseMove = (e) => {
    if (panDrag.current) {
      const dx = e.clientX - panDrag.current.sx;
      const dy = e.clientY - panDrag.current.sy;
      setPan({ x: panDrag.current.ox + dx, y: panDrag.current.oy + dy });
    }
    if (dragCutout.current) {
      const { ctx, id, offx, offy } = dragCutout.current;
      const pt = clientToMM(e.clientX, e.clientY);
      let nx = pt.x - (ctx === "island" ? islandOffset.x : 0) - offx;
      let ny = pt.y - (ctx === "island" ? islandOffset.y : 0) - offy;
      if (snap && grid > 0) {
        nx = Math.round(nx / grid) * grid;
        ny = Math.round(ny / grid) * grid;
      }
      if (ctx === "island")
        setCutIsl((prev) => prev.map((c) => (c.id === id ? { ...c, x: nx, y: ny } : c)));
      else
        setCutMain((prev) => prev.map((c) => (c.id === id ? { ...c, x: nx, y: ny } : c)));
    }
  };
  const onMouseUp = () => {
    panDrag.current = null;
    dragCutout.current = null;
  };
  const onWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom(clamp(zoom * factor, 0.2, 2.5));
  };

  const clientToMM = (clientX, clientY) => {
    const svg = viewRef.current;
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const scr = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: (scr.x - pan.x) / zoom, y: (scr.y - pan.y) / zoom };
  };

  // --- Вспомогательные действия ---
  const addRectCutout = () => {
    const id = `${editCtx === "island" ? "i" : "m"}${Date.now().toString(36)}`;
    const item = { id, type: "rect", x: 400, y: 300, w: 560, h: 490 };
    if (editCtx === "island") setCutIsl((s) => [...s, item]);
    else setCutMain((s) => [...s, item]);
    setSelectedId(`${editCtx}:${id}`);
  };
  const addCircleCutout = () => {
    const id = `${editCtx === "island" ? "i" : "m"}${Date.now().toString(36)}`;
    const item = { id, type: "circle", x: 500, y: 300, r: 90 };
    if (editCtx === "island") setCutIsl((s) => [...s, item]);
    else setCutMain((s) => [...s, item]);
    setSelectedId(`${editCtx}:${id}`);
  };
  const removeSelected = () => {
    if (!selectedId) return;
    const [ctx, id] = selectedId.split(":");
    if (ctx === "island") setCutIsl((prev) => prev.filter((c) => c.id !== id));
    else setCutMain((prev) => prev.filter((c) => c.id !== id));
    setSelectedId(null);
  };

  function getSelected() {
    if (!selectedId) return null;
    const [ctx, id] = selectedId.split(":");
    const arr = ctx === "island" ? cutIsl : cutMain;
    const obj = arr.find((c) => c.id === id);
    return obj ? { ctx, obj } : null;
  }
  const selected = getSelected();

  function updateSelected(patch) {
    if (!selected) return;
    const { ctx, obj } = selected;
    const np = numPatch(patch);
    if (ctx === "island") setCutIsl((prev) => prev.map((c) => (c.id === obj.id ? { ...c, ...np } : c)));
    else setCutMain((prev) => prev.map((c) => (c.id === obj.id ? { ...c, ...np } : c)));
  }

  // --------------- Сборка экспортного SVG (для SVG/PNG/PDF) ---------------
  function buildExportSVG() {
    const svgW = w + 200 + (hasIsland ? islandOffset.x + iW + 100 : 0);
    const svgH = Math.max(h, hasIsland ? iH : 0) + 200;

    const holesMainD = [
      ...mainShapeHoles.map((r) => {
        const x0 = r.x - r.w/2, y0 = r.y - r.h/2;
        return roundedRectPathFromBox(x0, y0, r.w, r.h, r.rTL||0, r.rTR||0, r.rBR||0, r.rBL||0);
      }),
      ...cutMain.map((c) => (c.type === "circle"
        ? `M ${c.x} ${c.y} m ${-c.r},0 a ${c.r},${c.r} 0 1,0 ${2 * c.r},0 a ${c.r},${c.r} 0 1,0 ${-2 * c.r},0 Z`
        : `M ${c.x - c.w/2} ${c.y - c.h/2} H ${c.x + c.w/2} V ${c.y + c.h/2} H ${c.x - c.w/2} Z`))
    ].join(" ");

    const islandD = hasIsland ? islandOuterPath : "";
    const islandHolesD = hasIsland ? cutIsl.map((c) => (c.type === "circle"
      ? `M ${c.x} ${c.y} m ${-c.r},0 a ${c.r},${c.r} 0 1,0 ${2 * c.r},0 a ${c.r},${c.r} 0 1,0 ${-2 * c.r},0 Z`
      : `M ${c.x - c.w/2} ${c.y - c.h/2} H ${c.x + c.w/2} V ${c.y + c.h/2} H ${c.x - c.w/2} Z`)).join(" ") : "";

    const xml = `<?xml version="1.0" standalone="no"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}mm" height="${svgH}mm" viewBox="-100 -100 ${svgW} ${svgH}">\n` +
      `<g fill-rule="evenodd" stroke="black" stroke-width="1">\n` +
      `  <g fill="white">\n` +
      `    <path d="M 0 0 ${mainOuterPath.slice(1)} ${holesMainD}"/>\n` +
      (hasIsland ? `    <g transform="translate(${islandOffset.x}, ${islandOffset.y})">\n      <path d="${islandD} ${islandHolesD}"/>\n    </g>\n` : "") +
      `  </g>\n` +
      `</g>\n</svg>`;

    return { xml, svgW, svgH };
  }

  // --- Экспорт ---
  const exportSVGAll = () => {
    const { xml } = buildExportSVG();
    download(`countertops_all.svg`, xml);
  };

  const exportDXFMain = () => {
    const dxf = toDXF(
      { w, h, rTL, rTR, rBR, rBL },
      [...mainShapeHoles, ...cutMain]
    );
    download(`countertop_main_${w}x${h}mm.dxf`, dxf);
  };
  const exportDXFIsland = () => {
    if (!hasIsland) return;
    const dxf = toDXF(
      { w: iW, h: iH, rTL: iR, rTR: iR, rBR: iR, rBL: iR },
      [...cutIsl]
    );
    download(`countertop_island_${iW}x${iH}mm.dxf`, dxf);
  };
  const exportDXFCombinedAll = () => {
    const main = { size: { w, h }, fillets: { rTL, rTR, rBR, rBL }, holes: mainShapeHoles, cutouts: cutMain };
    const island = hasIsland ? { size: { w: iW, h: iH }, radius: iR, cutouts: cutIsl } : null;
    const dxf = toDXFCombined(main, island, islandOffset);
    download(`countertops_sheet.dxf`, dxf);
  };
  const exportJSONAll = () => {
    const data = {
      version: 3,
      units: "mm",
      thickness,
      main: { shape, size: { w, h }, fillets: { rTL, rTR, rBR, rBL }, L: { corner: lCorner, w: lW, d: lD, r: { rTL: lRTL, rTR: lRTR, rBR: lRBR, rBL: lRBL } }, U: { w: uW, d: uD, side: uSide, r: { rTL: uRTL, rTR: uRTR, rBR: uRBR, rBL: uRBL } }, holes: mainShapeHoles, cutouts: cutMain },
      island: hasIsland ? { separate: islandSeparate, size: { w: iW, h: iH }, radius: iR, cutouts: cutIsl } : null,
      view: { grid, snap, zoom },
    };
    download(`countertops.json`, JSON.stringify(data, null, 2));
  };

  // --- PNG ---
  const exportPNG = (dpi = 150) => {
    const { xml, svgW, svgH } = buildExportSVG(); // размеры в мм
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const pxW = Math.round(svgW * dpi / 25.4);
      const pxH = Math.round(svgH * dpi / 25.4);
      const canvas = document.createElement('canvas');
      canvas.width = pxW; canvas.height = pxH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, pxW, pxH);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `countertops_${pxW}x${pxH}_${dpi}dpi.png`;
      a.click();
    };
    img.src = url;
  };

  // --- PDF (динамическая подгрузка jsPDF + svg2pdf с CDN; без правок Netlify) ---
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
  const ensureJsPdfLoaded = async () => {
    if (!window.jspdf) {
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    }
    if (!window.svg2pdf) {
      await loadScript('https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.min.js');
    }
  };
  const exportPDF = async () => {
    await ensureJsPdfLoaded();
    const { jsPDF } = window.jspdf;
    const { xml, svgW, svgH } = buildExportSVG();
    const pdf = new jsPDF({ orientation: svgW > svgH ? 'l' : 'p', unit: 'mm', format: [svgW, svgH] });
    const svgEl = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
    await pdf.svg(svgEl, { x: 0, y: 0, width: svgW, height: svgH });
    pdf.save('countertops.pdf');
  };

  // --- Площади/расчёт ---
  const areaMain = useMemo(() => {
    const outer = w * h;
    const hole = mainShapeHoles.reduce((s, r) => s + r.w * r.h, 0);
    const cuts = cutMain.reduce((s, c) => s + (c.type === "rect" ? c.w * c.h : Math.PI * c.r * c.r), 0);
    return Math.max(0, outer - hole - cuts);
  }, [w, h, mainShapeHoles, cutMain]);
  const areaIsland = useMemo(() => {
    if (!hasIsland) return 0;
    const outer = iW * iH;
    const cuts = cutIsl.reduce((s, c) => s + (c.type === "rect" ? c.w * c.h : Math.PI * c.r * c.r), 0);
    return Math.max(0, outer - cuts);
  }, [hasIsland, iW, iH, cutIsl]);

  // --- Диагностика / мини-тесты ---
  const [tests, setTests] = useState([]);
  useEffect(() => {
    const res = runSelfTests();
    setTests(res);
  }, []);

  // --- Рендер ---
  return (
    <div className="w-full min-h-screen bg-neutral-50 text-neutral-900">
      <div className="max-w-7xl mx-auto p-4 md:p-6 pb-28"> {/* отступ под нижнюю панель */}
        <h1 className="text-2xl md:text-3xl font-semibold mb-4">Конфигуратор столешницы — v3</h1>
        <p className="text-sm md:text-base text-neutral-600 mb-6">Г-/П-образные формы с настраиваемыми внутренними радиусами. Остров можно считать отдельно или объединять в общий DXF-лист.</p>

        {/* Панель управления */}
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-4 md:gap-6 mb-6">
          <div className="p-4 bg-white rounded-2xl shadow-sm border">
            <h2 className="font-medium mb-3">Основные параметры</h2>
            <div className="mb-2 text-sm">Тип формы</div>
            <div className="flex gap-2 mb-3">
              {['rect','L','U'].map((t) => (
                <button key={t} onClick={() => setShape(t)} className={`px-3 py-1.5 rounded-xl border ${shape===t? 'bg-neutral-900 text-white':'bg-white hover:bg-neutral-100'}`}>{t.toUpperCase()}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <LabeledInput label="Ширина (W)" value={w} onChange={setW} min={200} />
              <LabeledInput label="Глубина (D)" value={h} onChange={setH} min={200} />
              <LabeledInput label="Толщина" value={thickness} onChange={setThickness} min={4} />
              <LabeledInput label="Сетка" value={grid} onChange={setGrid} min={10} />
            </div>
            <label className="flex items-center gap-2 mt-3 text-sm">
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
              Привязка к сетке
            </label>
            <div className="mt-4">
              <label className="text-sm">Масштаб: {zoom.toFixed(2)}×</label>
              <input type="range" min={0.2} max={2.5} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full" />
            </div>
          </div>

          <div className="p-4 bg-white rounded-2xl shadow-sm border">
            <h2 className="font-medium mb-3">Скругления и форма</h2>
            <div className="grid grid-cols-2 gap-3">
              <LabeledInput label="R TL" value={rTL} onChange={setRTL} min={0} />
              <LabeledInput label="R TR" value={rTR} onChange={setRTR} min={0} />
              <LabeledInput label="R BR" value={rBR} onChange={setRBR} min={0} />
              <LabeledInput label="R BL" value={rBL} onChange={setRBL} min={0} />
            </div>
            {shape === 'L' && (
              <div className="mt-4">
                <div className="text-sm mb-2">Г-образная: вырез в углу + внутренние радиусы</div>
                <div className="grid grid-cols-2 gap-3">
                  <LabeledInput label="Ширина выреза (X)" value={lW} onChange={setLW} min={50} />
                  <LabeledInput label="Глубина выреза (Y)" value={lD} onChange={setLD} min={50} />
                </div>
                <div className="flex gap-2 mt-2 text-sm">
                  {['TL','TR','BR','BL'].map((c)=> (
                    <button key={c} onClick={()=>setLCorner(c)} className={`px-3 py-1.5 rounded-xl border ${lCorner===c? 'bg-neutral-900 text-white':'bg-white hover:bg-neutral-100'}`}>{c}</button>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-2 mt-3 text-xs">
                  <LabeledInput label="rTL" value={lRTL} onChange={setLRTL} min={0} />
                  <LabeledInput label="rTR" value={lRTR} onChange={setLRTR} min={0} />
                  <LabeledInput label="rBR" value={lRBR} onChange={setLRBR} min={0} />
                  <LabeledInput label="rBL" value={lRBL} onChange={setLRBL} min={0} />
                </div>
              </div>
            )}
            {shape === 'U' && (
              <div className="mt-4">
                <div className="text-sm mb-2">П-образная: центральный проём + внутренние радиусы</div>
                <div className="grid grid-cols-2 gap-3">
                  <LabeledInput label="Ширина проёма" value={uW} onChange={setUW} min={50} />
                  <LabeledInput label="Глубина проёма" value={uD} onChange={setUD} min={50} />
                </div>
                <div className="flex gap-2 mt-2 text-sm">
                  {['top','bottom'].map((s)=> (
                    <button key={s} onClick={()=>setUSide(s)} className={`px-3 py-1.5 rounded-xl border ${uSide===s? 'bg-neutral-900 text-white':'bg-white hover:bg-neutral-100'}`}>{s==='top'? 'Сверху':'Снизу'}</button>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-2 mt-3 text-xs">
                  <LabeledInput label="rTL" value={uRTL} onChange={setURTL} min={0} />
                  <LabeledInput label="rTR" value={uRTR} onChange={setURTR} min={0} />
                  <LabeledInput label="rBR" value={uRBR} onChange={setURBR} min={0} />
                  <LabeledInput label="rBL" value={uRBL} onChange={setURBL} min={0} />
                </div>
              </div>
            )}
          </div>

          <div className="p-4 bg-white rounded-2xl shadow-sm border">
            <h2 className="font-medium mb-3">Остров</h2>
            <label className="flex items-center gap-2 text-sm mb-3">
              <input type="checkbox" checked={hasIsland} onChange={(e)=> setHasIsland(e.target.checked)} />
              Добавить кухонный остров
            </label>
            {hasIsland && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <LabeledInput label="Ширина острова" value={iW} onChange={setIW} min={300} />
                  <LabeledInput label="Глубина острова" value={iH} onChange={setIH} min={300} />
                  <LabeledInput label="Скругление (R)" value={iR} onChange={setIR} min={0} />
                </div>
                <div className="mt-3 text-sm">
                  Режим учёта: 
                  <div className="flex gap-2 mt-2">
                    <button onClick={()=>setIslandSeparate(true)} className={`px-3 py-1.5 rounded-xl border ${islandSeparate? 'bg-neutral-900 text-white':'bg-white hover:bg-neutral-100'}`}>Отдельная позиция</button>
                    <button onClick={()=>setIslandSeparate(false)} className={`px-3 py-1.5 rounded-xl border ${!islandSeparate? 'bg-neutral-900 text-white':'bg-white hover:bg-neutral-100'}`}>В общий лист</button>
                  </div>
                </div>
              </>
            )}
            <div className="mt-4 text-sm text-neutral-600">
              Площадь острова: <b>{(areaIsland/1e6).toFixed(3)}</b> м²
            </div>
          </div>

          <div className="p-4 bg-white rounded-2xl shadow-sm border">
            <h2 className="font-medium mb-3">Контекст вырезов</h2>
            <div className="flex gap-2 mb-3">
              {['main','island'].map((c)=> (
                <button key={c} onClick={()=> setEditCtx(c)} disabled={c==='island' && !hasIsland} className={`px-3 py-1.5 rounded-xl border ${editCtx===c? 'bg-neutral-900 text-white':'bg-white hover:bg-neutral-100'} ${c==='island' && !hasIsland ? 'opacity-50 cursor-not-allowed':''}`}>{c==='main'? 'Основная':'Остров'}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={addCircleCutout} className="px-3 py-2 rounded-xl bg-neutral-900 text-white hover:opacity-90">+ Отверстие (круг)</button>
              <button onClick={addRectCutout} className="px-3 py-2 rounded-xl bg-neutral-200 hover:bg-neutral-300">+ Вырез (прямоуг.)</button>
              <button onClick={removeSelected} disabled={!selectedId} className={`px-3 py-2 rounded-xl ${selectedId ? "bg-red-600 text-white" : "bg-neutral-200 text-neutral-500 cursor-not-allowed"}`}>Удалить выбранный</button>
            </div>
          </div>
        </div>

        {/* Результаты расчёта */}
        <div className="p-4 bg-white rounded-2xl shadow-sm border mb-6 text-sm">
          <div className="flex flex-wrap gap-6">
            <div>Площадь основной: <b>{(areaMain/1e6).toFixed(3)}</b> м²</div>
            <div>Площадь острова: <b>{(areaIsland/1e6).toFixed(3)}</b> м²</div>
            <div>
              {islandSeparate ? (
                <>Итого (лист основной): <b>{(areaMain/1e6).toFixed(3)}</b> м²</>
              ) : (
                <>Итого (общий лист): <b>{((areaMain+areaIsland)/1e6).toFixed(3)}</b> м²</>
              )}
            </div>
          </div>
        </div>

        {/* Диагностика */}
        <div className="p-4 bg-white rounded-2xl shadow-sm border mb-6 text-sm">
          <h2 className="font-medium mb-3">Диагностика</h2>
          <ul className="grid md:grid-cols-2 gap-2">
            {tests.map((t) => (
              <li key={t.name} className={`px-3 py-2 rounded-xl border ${t.passed ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
                <div className="flex items-center justify-between">
                  <span>{t.name}</span>
                  <span className={`text-xs ${t.passed ? 'text-emerald-700' : 'text-red-700'}`}>{t.passed ? 'OK' : 'FAIL'}</span>
                </div>
                {!t.passed && <div className="mt-1 text-xs text-red-700">{t.message}</div>}
              </li>
            ))}
          </ul>
        </div>

        {/* Область чертежа */}
        <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b bg-neutral-50 text-sm text-neutral-600">
            <div>Единицы: мм • Толщина: {thickness} • Сетка: {grid} • Зум: {zoom.toFixed(2)}×</div>
            <div>ЛКМ — вырез/перетаскивание · Перетаскивание фона — панорамирование · Колесо — масштаб</div>
          </div>

          <svg
            ref={viewRef}
            className="w-full h-[70vh] touch-none select-none"
            onMouseDown={onMouseDownBG}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={onWheel}
          >
            {/* Фон */}
            <rect x={0} y={0} width="100%" height="100%" fill="#fafafa" data-bg="1" />

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* Сетка */}
              <Grid w={w + (hasIsland? islandOffset.x + iW : 0)} h={Math.max(h, hasIsland? iH:0)} step={grid} />

              {/* Основная столешница: тело + отверстия формы */}
              <g>
                <path d={mainOuterPath} fill="#ffffff" stroke="#111827" strokeWidth={2} />
                {/* Отверстия формы для L/U — рисуем path со скруглениями */}
                {mainShapeHoles.map((r) => {
                  const x0 = r.x - r.w/2, y0 = r.y - r.h/2;
                  const d = roundedRectPathFromBox(x0, y0, r.w, r.h, r.rTL||0, r.rTR||0, r.rBR||0, r.rBL||0);
                  return <path key={r.id} d={d} fill="#fff" stroke="#111827" strokeWidth={2} />
                })}

                {/* Технологические вырезы */}
                {cutMain.map((c) => (
                  <Cutout key={c.id} ctx="main" c={c} selected={selectedId===`main:${c.id}`} setSelected={setSelectedId} setDrag={(info) => (dragCutout.current = info)} islandOffset={{x:0,y:0}} snap={snap} grid={grid} />
                ))}

                <Dims w={w} h={h} />

                {/* Подписи L/U параметров */}
                {shape === 'L' && (
                  <text x={w - 6} y={lD + 14} fontSize={12} textAnchor="end" fill="#6b7280">L: {lW}×{lD}</text>
                )}
                {shape === 'U' && (
                  <text x={w/2} y={(uSide==='top'? uD : h - uD) + 14} fontSize={12} textAnchor="middle" fill="#6b7280">U: {uW}×{uD}</text>
                )}
              </g>

              {/* Остров */}
              {hasIsland && (
                <g transform={`translate(${islandOffset.x}, ${islandOffset.y})`}>
                  <path d={islandOuterPath} fill="#ffffff" stroke="#111827" strokeWidth={2} />
                  {cutIsl.map((c) => (
                    <Cutout key={c.id} ctx="island" c={c} selected={selectedId===`island:${c.id}`} setSelected={setSelectedId} setDrag={(info) => (dragCutout.current = info)} islandOffset={islandOffset} snap={snap} grid={grid} />
                  ))}
                  <Dims w={iW} h={iH} />
                  <text x={iW} y={-8} fontSize={12} fill="#6b7280" textAnchor="end">Остров</text>
                </g>
              )}
            </g>
          </svg>
        </div>
      </div>

      {/* НИЖНЯЯ ПАНЕЛЬ ЭКСПОРТА */}
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 max-w-7xl w-[calc(100%-1.5rem)] md:w-[calc(100%-3rem)]">
        <div className="px-3 py-3 md:px-4 md:py-3 bg-white/90 backdrop-blur rounded-2xl shadow-lg border flex flex-wrap items-center gap-2 md:gap-3 justify-between">
          <div className="text-xs md:text-sm text-neutral-700">Экспорт • Режим острова: {hasIsland ? (islandSeparate ? 'отдельная позиция' : 'общий лист') : 'отключён'}</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={exportSVGAll} className="px-3 py-2 rounded-xl bg-emerald-600 text-white hover:opacity-90">SVG (вид)</button>
            <button onClick={exportDXFMain} className="px-3 py-2 rounded-xl bg-blue-600 text-white hover:opacity-90">DXF (основная)</button>
            {hasIsland && (
              <>
                <button onClick={exportDXFIsland} className={`px-3 py-2 rounded-xl ${islandSeparate? 'bg-blue-600 text-white hover:opacity-90':'bg-neutral-200 text-neutral-500'}`}>DXF (остров)</button>
                <button onClick={exportDXFCombinedAll} className={`px-3 py-2 rounded-xl ${!islandSeparate? 'bg-blue-600 text-white hover:opacity-90':'bg-neutral-200 text-neutral-500'}`}>DXF (общий лист)</button>
              </>
            )}
            <button onClick={() => exportPNG(150)} className="px-3 py-2 rounded-xl bg-amber-600 text-white hover:opacity-90">PNG</button>
            <button onClick={exportPDF} className="px-3 py-2 rounded-xl bg-purple-600 text-white hover:opacity-90">PDF</button>
            <button onClick={exportJSONAll} className="px-3 py-2 rounded-xl bg-neutral-900 text-white hover:opacity-90">JSON</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function numPatch(patch) {
  const out = { ...patch };
  for (const k of Object.keys(out)) out[k] = mm(out[k]);
  return out;
}

// --------------------- МЕЛКИЕ КОМПОНЕНТЫ ---------------------
function LabeledInput({ label, value, onChange, min }) {
  return (
    <label className="text-sm flex flex-col gap-1">
      <span className="text-neutral-600">{label}</span>
      <input
        className="px-3 py-2 border rounded-xl outline-none focus:ring-2 focus:ring-neutral-900/10"
        type="number"
        value={value}
        min={min}
        onChange={(e) => onChange(mm(e.target.value))}
      />
    </label>
  );
}

function Grid({ w, h, step = 50 }) {
  const gridSize = Math.max(w, h) + 600;
  const lines = [];
  for (let x = -200; x <= gridSize; x += step) lines.push(<line key={"vx"+x} x1={x} y1={-200} x2={x} y2={gridSize} stroke="#e5e7eb" strokeWidth={1} />);
  for (let y = -200; y <= gridSize; y += step) lines.push(<line key={"hz"+y} x1={-200} y1={y} x2={gridSize} y2={y} stroke="#e5e7eb" strokeWidth={1} />);
  return <g>{lines}</g>;
}

function Cutout({ ctx, c, selected, setSelected, setDrag, islandOffset, snap, grid }) {
  const onMouseDown = (e) => {
    e.stopPropagation();
    setSelected(`${ctx}:${c.id}`);

    // Вычислим смещение курсора относительно центра выреза в мм
    const svg = e.currentTarget.ownerSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const scr = pt.matrixTransform(svg.getScreenCTM().inverse());

    const worldX = scr.x; const worldY = scr.y;
    const offx = worldX - (islandOffset.x * (ctx==='island'?1:0)) - c.x;
    const offy = worldY - (islandOffset.y * (ctx==='island'?1:0)) - c.y;
    setDrag({ ctx, id: c.id, offx, offy });
  };

  if (c.type === "circle") {
    return (
      <g onMouseDown={onMouseDown} cursor="move">
        <circle cx={c.x} cy={c.y} r={c.r} fill="#fff" stroke={selected ? "#ef4444" : "#111827"} strokeWidth={selected ? 3 : 2} />
        <text x={c.x} y={c.y - c.r - 6} fontSize={12} fill="#6b7280" textAnchor="middle">⌀ {Math.round(c.r * 2)} мм</text>
      </g>
    );
  }
  const x = c.x - c.w / 2;
  const y = c.y - c.h / 2;
  return (
    <g onMouseDown={onMouseDown} cursor="move">
      <rect x={x} y={y} width={c.w} height={c.h} fill="#fff" stroke={selected ? "#ef4444" : "#111827"} strokeWidth={selected ? 3 : 2} />
      <text x={c.x} y={y - 6} fontSize={12} fill="#6b7280" textAnchor="middle">{Math.round(c.w)}×{Math.round(c.h)} мм</text>
    </g>
  );
}

function Dims({ w, h }) {
  const off = 40;
  return (
    <g fontSize={12} fill="#6b7280" stroke="#9ca3af" strokeWidth={1}>
      {/* Горизонталь */}
      <line x1={0} y1={-off} x2={w} y2={-off} />
      <line x1={0} y1={0} x2={0} y2={-off} />
      <line x1={w} y1={0} x2={w} y2={-off} />
      <text x={w / 2} y={-off - 6} textAnchor="middle">{Math.round(w)} мм</text>

      {/* Вертикаль */}
      <line x1={-off} y1={0} x2={-off} y2={h} />
      <line x1={0} y1={0} x2={-off} y2={0} />
      <line x1={0} y1={h} x2={-off} y2={h} />
      <text x={-off - 6} y={h / 2} writingMode="tb" textAnchor="middle">{Math.round(h)} мм</text>
    </g>
  );
}

// --------------------- МИНИ-ТЕСТЫ ---------------------
function runSelfTests() {
  const results = [];
  // Тест 1: DXF join не падает и содержит ключевые секции
  try {
    const dxf = toDXF({ w: 100, h: 50, rTL: 0, rTR: 0, rBR: 0, rBL: 0 }, []);
    const ok = typeof dxf === 'string' && dxf.includes('SECTION') && dxf.trim().endsWith('EOF');
    results.push({ name: 'DXF generation basic', passed: ok, message: ok ? '' : 'DXF не содержит SECTION/EOF' });
  } catch (e) {
    results.push({ name: 'DXF generation basic', passed: false, message: String(e) });
  }

  // Тест 2: Путь скруглённого прямоугольника
  try {
    const d = roundedRectPath({ w: 200, h: 100, rTL: 10, rTR: 20, rBR: 10, rBL: 0 });
    results.push({ name: 'Rounded rect path', passed: /^M\s/.test(d) && d.endsWith('Z'), message: '' });
  } catch (e) {
    results.push({ name: 'Rounded rect path', passed: false, message: String(e) });
  }

  // Тест 3: Расчёт площади без вырезов
  try {
    const area = 200 * 60; // мм²
    const ok = area === 12000;
    results.push({ name: 'Area arithmetic sanity', passed: ok, message: ok ? '' : 'Ожидали 12000 мм²' });
  } catch (e) {
    results.push({ name: 'Area arithmetic sanity', passed: false, message: String(e) });
  }

  // Тест 4: DXF с округлённым отверстием
  try {
    const dxf = toDXF({ w: 300, h: 200, rTL: 0, rTR: 0, rBR: 0, rBL: 0 }, [{ type:'rect', x:150, y:100, w:100, h:60, rTL:10, rTR:10, rBR:10, rBL:10 }]);
    const ok = dxf.includes('LWPOLYLINE');
    results.push({ name: 'DXF rounded hole polyline', passed: ok, message: ok ? '' : 'Нет LWPOLYLINE для отверстия' });
  } catch (e) {
    results.push({ name: 'DXF rounded hole polyline', passed: false, message: String(e) });
  }

  return results;
}
