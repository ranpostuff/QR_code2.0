(function () {
  "use strict";

  // The old page was 1414 x 2000. Every measurement below is exactly 4x,
  // so Canva receives a much larger image without changing the layout.
  const SCALE = 4;
  const PAGE_WIDTH = 1414 * SCALE;
  const PAGE_HEIGHT = 2000 * SCALE;
  const COLUMNS = 5;
  const ROWS = 7;
  const PER_PAGE = COLUMNS * ROWS;
  const CARD_WIDTH = 247 * SCALE;
  const CARD_HEIGHT = 259 * SCALE;
  const COLUMN_GAP = 27 * SCALE;
  const ROW_GAP = 24 * SCALE;
  const LEFT_MARGIN = 35 * SCALE;
  const TOP_MARGIN = 20 * SCALE;
  // The active QR pattern now fills the card like the reference image.
  // Each module remains an exact integer 40 x 40 pixels in the exported PNG.
  const QR_MODULE_PIXELS = 40;
  const QR_QUIET_ZONE_MODULES = 1;
  const QR_MODULES_WITH_QUIET_ZONE = 21 + QR_QUIET_ZONE_MODULES * 2;
  const QR_SIZE = QR_MODULE_PIXELS * QR_MODULES_WITH_QUIET_ZONE;
  let students = [];
  let lastDetection = { students: [], rejected: [] };

  function clean(value) {
    return String(value == null ? "" : value).replace(/\u00a0/g, " ").trim();
  }

  function exactLrn(value) {
    const text = clean(value).replace(/^['\u2019]/, "");
    return /^\d{12}$/.test(text) ? text : null;
  }

  function normalizedHeader(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function findHeaderInformation(rows) {
    const maximum = Math.min(rows.length, 10);
    for (let rowIndex = 0; rowIndex < maximum; rowIndex += 1) {
      const headers = rows[rowIndex].map(normalizedHeader);
      const nameColumn = headers.findIndex((value) =>
        /^(name of (the )?student|student name|name of learner|learner name|pupil name)$/.test(value) ||
        ((/\bstudent\b|\blearner\b|\bpupil\b/).test(value) && /\bname\b/.test(value))
      );
      const lrnColumn = headers.findIndex((value) =>
        value === "lrn" || /learner reference (number|no)/.test(value)
      );
      if (nameColumn >= 0 || lrnColumn >= 0) {
        return { rowIndex, headers, nameColumn, lrnColumn };
      }
    }
    return { rowIndex: -1, headers: [], nameColumn: -1, lrnColumn: -1 };
  }

  function plausibleName(value) {
    const text = clean(value);
    if (!text || exactLrn(text) || /@/.test(text) || /^\+?[\d\s().-]{7,}$/.test(text)) return false;
    if (/^(lrn|email|phone|contact|parent|name|student|no\.?|number)$/i.test(text)) return false;
    return /[a-zA-ZÀ-ÿ]/.test(text);
  }

  function parseRows(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.split("\t").map(clean))
      .filter((row) => row.some(Boolean));
  }

  function detectStudents(rows) {
    if (!rows.length) return { students: [], rejected: [] };
    const header = findHeaderInformation(rows);
    const start = header.rowIndex >= 0 ? header.rowIndex + 1 : 0;
    const ignoredNameColumns = new Set();
    header.headers.forEach((value, index) => {
      if (/parent|guardian|mother|father|email|phone|contact|address|number/.test(value)) ignoredNameColumns.add(index);
    });

    const found = [];
    const rejected = [];
    for (let rowIndex = start; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const exactValues = row.map((cell, column) => ({ value: exactLrn(cell), column })).filter((item) => item.value);
      let selectedLrn = null;
      if (header.lrnColumn >= 0 && exactLrn(row[header.lrnColumn])) {
        selectedLrn = { value: exactLrn(row[header.lrnColumn]), column: header.lrnColumn };
      } else if (exactValues.length === 1) {
        selectedLrn = exactValues[0];
      }
      if (!selectedLrn) {
        rejected.push({
          row: rowIndex + 1,
          reason: exactValues.length > 1 ? "multiple 12-digit values and no clear LRN column" : "no exact 12-digit LRN"
        });
        continue;
      }

      const lrn = selectedLrn.value;
      let name = header.nameColumn >= 0 ? clean(row[header.nameColumn]) : "";
      if (!plausibleName(name)) {
        name = row.find((cell, index) =>
          index !== selectedLrn.column && !ignoredNameColumns.has(index) && plausibleName(cell)
        ) || "";
      }
      if (!name) {
        rejected.push({ row: rowIndex + 1, reason: "student name not found" });
        continue;
      }
      found.push({ name, lrn, sourceRow: rowIndex + 1, cells: row.slice() });
    }
    return { students: found, rejected };
  }

  function renderPreview(result) {
    lastDetection = result;
    students = result.students;
    const status = document.getElementById("status");
    const results = document.getElementById("results");
    const body = document.getElementById("studentRows");
    const exportButton = document.getElementById("exportButton");
    body.textContent = "";

    students.forEach((student) => {
      const tr = document.createElement("tr");
      [student.name, student.lrn, "Ready to export"].forEach((value) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    document.getElementById("studentCount").textContent =
      `${students.length} student${students.length === 1 ? "" : "s"} will be created.`;
    results.hidden = students.length === 0;
    exportButton.disabled = students.length === 0;
    status.textContent = `${students.length} valid student${students.length === 1 ? "" : "s"} detected` +
      (result.rejected.length ? `; ${result.rejected.length} unrelated or invalid row${result.rejected.length === 1 ? "" : "s"} ignored.` : ".");
  }

  function detectFromPaste() {
    const rows = parseRows(document.getElementById("pasteBox").value);
    renderPreview(detectStudents(rows));
  }

  // Minimal standards-compliant QR encoder for an exact 12-digit numeric LRN.
  // It creates a Version 1-M QR (21 x 21 modules) with Reed-Solomon correction.
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function buildGaloisTables() {
    let value = 1;
    for (let i = 0; i < 255; i += 1) {
      GF_EXP[i] = value;
      GF_LOG[value] = i;
      value <<= 1;
      if (value & 0x100) value ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
  }());

  function gfMultiply(a, b) {
    return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
  }

  function generatorPolynomial(degree) {
    let result = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(result.length + 1).fill(0);
      for (let j = 0; j < result.length; j += 1) {
        next[j] ^= result[j];
        next[j + 1] ^= gfMultiply(result[j], GF_EXP[i]);
      }
      result = next;
    }
    return result;
  }

  function reedSolomon(data, degree) {
    const generator = generatorPolynomial(degree);
    const message = data.concat(new Array(degree).fill(0));
    for (let i = 0; i < data.length; i += 1) {
      const factor = message[i];
      if (!factor) continue;
      for (let j = 0; j < generator.length; j += 1) {
        message[i + j] ^= gfMultiply(generator[j], factor);
      }
    }
    return message.slice(data.length);
  }

  function appendBits(target, value, length) {
    for (let bit = length - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1);
  }

  function makeCodewords(lrn) {
    if (!/^\d{12}$/.test(lrn)) throw new Error("Every LRN must contain exactly 12 digits.");
    const bits = [];
    appendBits(bits, 0x1, 4); // numeric mode
    appendBits(bits, lrn.length, 10); // Version 1 numeric length
    for (let i = 0; i < lrn.length; i += 3) {
      const group = lrn.slice(i, i + 3);
      appendBits(bits, Number(group), group.length === 3 ? 10 : group.length === 2 ? 7 : 4);
    }
    const capacity = 16 * 8; // Version 1-M data capacity
    appendBits(bits, 0, Math.min(4, capacity - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
      data.push(byte);
    }
    for (let pad = 0; data.length < 16; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
    return data.concat(reedSolomon(data, 10));
  }

  function markFinder(matrix, functional, left, top) {
    const size = matrix.length;
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const xx = left + x;
        const yy = top + y;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const black = x >= 0 && x <= 6 && y >= 0 && y <= 6 &&
          (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
        matrix[yy][xx] = black;
        functional[yy][xx] = true;
      }
    }
  }

  function formatBits(mask) {
    const data = mask; // Error correction M = binary 00
    let remainder = data << 10;
    for (let bit = 14; bit >= 10; bit -= 1) {
      if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
    }
    return ((data << 10) | remainder) ^ 0x5412;
  }

  function setFormat(matrix, functional, mask) {
    const size = matrix.length;
    const value = formatBits(mask);
    const set = (x, y, bit) => {
      matrix[y][x] = ((value >>> bit) & 1) !== 0;
      functional[y][x] = true;
    };
    for (let i = 0; i <= 5; i += 1) set(8, i, i);
    set(8, 7, 6);
    set(8, 8, 7);
    set(7, 8, 8);
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, i);
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, i);
    matrix[size - 8][8] = true;
    functional[size - 8][8] = true;
  }

  function maskCondition(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function penalty(matrix) {
    const size = matrix.length;
    let score = 0;
    const linePenalty = (getter) => {
      for (let a = 0; a < size; a += 1) {
        let runColor = getter(a, 0);
        let runLength = 1;
        for (let b = 1; b < size; b += 1) {
          const color = getter(a, b);
          if (color === runColor) runLength += 1;
          else {
            if (runLength >= 5) score += 3 + runLength - 5;
            runColor = color;
            runLength = 1;
          }
        }
        if (runLength >= 5) score += 3 + runLength - 5;
      }
    };
    linePenalty((row, column) => matrix[row][column]);
    linePenalty((column, row) => matrix[row][column]);
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = matrix[y][x];
        if (matrix[y][x + 1] === color && matrix[y + 1][x] === color && matrix[y + 1][x + 1] === color) score += 3;
      }
    }
    const finderPattern = [true, false, true, true, true, false, true];
    const scanPatterns = (getter) => {
      for (let a = 0; a < size; a += 1) {
        for (let b = 0; b <= size - 7; b += 1) {
          if (!finderPattern.every((value, i) => getter(a, b + i) === value)) continue;
          const before = b >= 4 && [1, 2, 3, 4].every((i) => !getter(a, b - i));
          const after = b + 10 < size && [7, 8, 9, 10].every((i) => !getter(a, b + i));
          if (before || after) score += 40;
        }
      }
    };
    scanPatterns((row, column) => matrix[row][column]);
    scanPatterns((column, row) => matrix[row][column]);
    const dark = matrix.flat().filter(Boolean).length;
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  function createQrMatrix(lrn) {
    const size = 21;
    const base = Array.from({ length: size }, () => new Array(size).fill(false));
    const functional = Array.from({ length: size }, () => new Array(size).fill(false));
    markFinder(base, functional, 0, 0);
    markFinder(base, functional, size - 7, 0);
    markFinder(base, functional, 0, size - 7);
    for (let i = 8; i < size - 8; i += 1) {
      base[6][i] = i % 2 === 0;
      base[i][6] = i % 2 === 0;
      functional[6][i] = true;
      functional[i][6] = true;
    }
    setFormat(base, functional, 0); // also reserves every format module

    const dataBits = [];
    makeCodewords(lrn).forEach((byte) => appendBits(dataBits, byte, 8));
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      const matrix = base.map((row) => row.slice());
      let bitIndex = 0;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right -= 1;
        for (let vertical = 0; vertical < size; vertical += 1) {
          const y = upward ? size - 1 - vertical : vertical;
          for (let offset = 0; offset < 2; offset += 1) {
            const x = right - offset;
            if (functional[y][x]) continue;
            const bit = bitIndex < dataBits.length ? dataBits[bitIndex] !== 0 : false;
            matrix[y][x] = bit !== maskCondition(mask, x, y);
            bitIndex += 1;
          }
        }
        upward = !upward;
      }
      setFormat(matrix, functional, mask);
      const score = penalty(matrix);
      if (score < bestScore) {
        bestScore = score;
        best = matrix;
      }
    }
    return best;
  }

  function drawQr(context, matrix, left, top) {
    context.fillStyle = "#ffffff";
    context.fillRect(left, top, QR_SIZE, QR_SIZE);
    context.fillStyle = "#000000";
    const quiet = QR_QUIET_ZONE_MODULES;
    for (let y = 0; y < matrix.length; y += 1) {
      for (let x = 0; x < matrix.length; x += 1) {
        if (matrix[y][x]) {
          context.fillRect(
            left + (x + quiet) * QR_MODULE_PIXELS,
            top + (y + quiet) * QR_MODULE_PIXELS,
            QR_MODULE_PIXELS,
            QR_MODULE_PIXELS
          );
        }
      }
    }
  }

  function fitName(context, name, maxWidth) {
    let size = 14 * SCALE;
    const minimum = 9 * SCALE;
    while (size > minimum) {
      context.font = `${size}px Arial, sans-serif`;
      if (context.measureText(name).width <= maxWidth) break;
      size -= 2;
    }
    context.font = `${size}px Arial, sans-serif`;
    return name;
  }

  function renderPage(pageStudents) {
    const canvas = document.createElement("canvas");
    canvas.width = PAGE_WIDTH;
    canvas.height = PAGE_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    context.textAlign = "center";
    context.textBaseline = "middle";

    pageStudents.forEach((student, index) => {
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      const x = LEFT_MARGIN + column * (CARD_WIDTH + COLUMN_GAP);
      const y = TOP_MARGIN + row * (CARD_HEIGHT + ROW_GAP);
      context.strokeStyle = "#000000";
      context.lineWidth = SCALE;
      context.strokeRect(x + SCALE / 2, y + SCALE / 2, CARD_WIDTH - SCALE, CARD_HEIGHT - SCALE);

      const qrX = x + Math.floor((CARD_WIDTH - QR_SIZE) / 2);
      const qrY = y + 4 * SCALE;
      drawQr(context, createQrMatrix(student.lrn), qrX, qrY);

      context.fillStyle = "#000000";
      fitName(context, student.name, CARD_WIDTH - 10 * SCALE);
      context.fillText(student.name, x + CARD_WIDTH / 2, y + CARD_HEIGHT - 13 * SCALE);
    });
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser could not create the PNG.")), "image/png");
    });
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let k = 0; k < 8; k += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      table[n] = value >>> 0;
    }
    return table;
  }());

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function write16(array, offset, value) {
    array[offset] = value & 0xff;
    array[offset + 1] = (value >>> 8) & 0xff;
  }

  function write32(array, offset, value) {
    array[offset] = value & 0xff;
    array[offset + 1] = (value >>> 8) & 0xff;
    array[offset + 2] = (value >>> 16) & 0xff;
    array[offset + 3] = (value >>> 24) & 0xff;
  }

  async function makeZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = new Uint8Array(await file.blob.arrayBuffer());
      const checksum = crc32(data);
      const local = new Uint8Array(30 + name.length);
      write32(local, 0, 0x04034b50);
      write16(local, 4, 20);
      write16(local, 6, 0x0800);
      write16(local, 8, 0); // stored, no compression
      write32(local, 14, checksum);
      write32(local, 18, data.length);
      write32(local, 22, data.length);
      write16(local, 26, name.length);
      local.set(name, 30);
      chunks.push(local, data);

      const entry = new Uint8Array(46 + name.length);
      write32(entry, 0, 0x02014b50);
      write16(entry, 4, 20);
      write16(entry, 6, 20);
      write16(entry, 8, 0x0800);
      write16(entry, 10, 0);
      write32(entry, 16, checksum);
      write32(entry, 20, data.length);
      write32(entry, 24, data.length);
      write16(entry, 28, name.length);
      write32(entry, 42, offset);
      entry.set(name, 46);
      central.push(entry);
      offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
    const end = new Uint8Array(22);
    write32(end, 0, 0x06054b50);
    write16(end, 8, files.length);
    write16(end, 10, files.length);
    write32(end, 12, centralSize);
    write32(end, 16, offset);
    return new Blob(chunks.concat(central, [end]), { type: "application/zip" });
  }

  async function exportImages() {
    detectFromPaste();
    if (!students.length) {
      alert("No valid student rows were found. Each row needs one exact 12-digit LRN and a student name.");
      return;
    }
    const button = document.getElementById("exportButton");
    button.disabled = true;
    const status = document.getElementById("status");
    try {
      const pageCount = Math.ceil(students.length / PER_PAGE);
      const files = [];
      for (let page = 0; page < pageCount; page += 1) {
        status.textContent = `Rendering high-resolution page ${page + 1} of ${pageCount}…`;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const canvas = renderPage(students.slice(page * PER_PAGE, (page + 1) * PER_PAGE));
        const blob = await canvasToBlob(canvas);
        files.push({ name: `student-qr-page-${page + 1}.png`, blob });
      }
      if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
      else downloadBlob(await makeZip(files), "student-qr-pages-high-resolution.zip");
      status.textContent = `${students.length} QR code${students.length === 1 ? "" : "s"} exported at 5656 × 8000 pixels per page.`;
    } catch (error) {
      console.error(error);
      status.textContent = `Export failed: ${error.message}`;
      alert(`Export failed: ${error.message}`);
    } finally {
      button.disabled = students.length === 0;
    }
  }

  function initialize() {
    const pasteBox = document.getElementById("pasteBox");
    const exportButton = document.getElementById("exportButton");
    const status = document.getElementById("status");
    if (!pasteBox || !exportButton || !status) {
      throw new Error("The page files do not match. Replace both index.html and script.js with the same version.");
    }
    let detectionTimer = 0;
    pasteBox.addEventListener("input", () => {
      clearTimeout(detectionTimer);
      detectionTimer = setTimeout(detectFromPaste, 100);
    });
    pasteBox.addEventListener("paste", () => setTimeout(detectFromPaste, 0));
    exportButton.addEventListener("click", exportImages);
    status.textContent = "Paste spreadsheet data above. Detection happens automatically.";

    const video = document.getElementById("tutorialVideo");
    let pausedAtOneMinute = false;
    video.addEventListener("timeupdate", () => {
      if (!pausedAtOneMinute && video.currentTime >= 60) {
        pausedAtOneMinute = true;
        video.pause();
      }
    });
  }

  if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", initialize);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createQrMatrix, makeCodewords, detectStudents, parseRows, formatBits };
  }
}());
