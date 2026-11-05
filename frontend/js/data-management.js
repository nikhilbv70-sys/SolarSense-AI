(function () {
  const expectedHeaders = [
    "timestamp", "irradiance", "panel_temperature", "voltage",
    "current", "power", "expected_power", "inverter_status"
  ];
  const numericHeaders = ["irradiance", "panel_temperature", "voltage", "current", "power", "expected_power"];
  let initialized = false;

  function parseCsvLine(line) {
    const cells = [];
    let value = "";
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"' && quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === "," && !quoted) {
        cells.push(value.trim());
        value = "";
      } else {
        value += character;
      }
    }

    cells.push(value.trim());
    return cells;
  }

  function setStatus(kind, message, checks) {
    const status = document.getElementById("validation-status");
    status.className = "validation-status " + kind;
    document.getElementById("validation-message").textContent = message;
    const list = document.getElementById("validation-list");
    list.replaceChildren();
    checks.forEach(function (check) {
      const item = document.createElement("li");
      item.textContent = check;
      list.appendChild(item);
    });
  }

  function renderTable(headers, rows) {
    const head = document.getElementById("csv-head");
    const body = document.getElementById("csv-body");
    head.replaceChildren();
    body.replaceChildren();

    const headerRow = document.createElement("tr");
    headers.forEach(function (header) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = header;
      headerRow.appendChild(cell);
    });
    head.appendChild(headerRow);

    rows.slice(0, 6).forEach(function (row) {
      const tableRow = document.createElement("tr");
      headers.forEach(function (header) {
        const cell = document.createElement("td");
        cell.textContent = row[header] || "—";
        if (!row[header]) cell.className = "missing-cell";
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });

    document.getElementById("preview-count").textContent = rows.length + (rows.length === 1 ? " row" : " rows");
    document.getElementById("preview-description").textContent = "Showing " + Math.min(rows.length, 6) + " of " + rows.length + " rows · processed locally in this browser.";
    document.getElementById("preview-panel").hidden = false;
    document.getElementById("clear-csv").disabled = false;
  }

  function validateAndRender(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(function (line) {
      return line.trim().length > 0;
    });
    if (lines.length < 2) {
      setStatus("error", "The CSV needs a header row and at least one data row.", ["No data rows found."]);
      return;
    }

    const headers = parseCsvLine(lines[0]).map(function (header) { return header.toLowerCase(); });
    const missingHeaders = expectedHeaders.filter(function (header) { return !headers.includes(header); });
    if (missingHeaders.length) {
      setStatus("error", "Required CSV columns are missing.", ["Missing columns: " + missingHeaders.join(", ")]);
      return;
    }

    const warnings = [];
    let missingValues = 0;
    let invalidValues = 0;
    const rows = lines.slice(1).map(function (line, rowIndex) {
      const cells = parseCsvLine(line);
      const row = {};
      headers.forEach(function (header, index) {
        row[header] = cells[index] || "";
        if (expectedHeaders.includes(header) && !row[header]) missingValues += 1;
        if (numericHeaders.includes(header) && row[header] && !Number.isFinite(Number(row[header]))) {
          invalidValues += 1;
          if (row[header].match(/[a-z/°²]/i)) warnings.push("Row " + (rowIndex + 2) + ": " + header + " should be numeric; check its unit.");
        }
      });
      if (cells.length !== headers.length) warnings.push("Row " + (rowIndex + 2) + ": column count differs from the header.");
      return row;
    });

    if (missingValues) warnings.unshift(missingValues + " required field(s) are empty.");
    if (invalidValues) warnings.unshift(invalidValues + " numeric field(s) contain invalid values.");
    if (!warnings.length) warnings.push("All required columns and sample numeric values are present.");
    renderTable(headers, rows);
    const hasWarnings = warnings[0] !== "All required columns and sample numeric values are present.";
    setStatus(hasWarnings ? "warning" : "success",
      hasWarnings ? "Preview loaded with validation warnings." : "CSV preview validated locally.",
      warnings.slice(0, 5));
  }

  function readFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setStatus("error", "Unsupported file type. Please choose a .csv file.", ["Only comma-separated CSV files are supported."]);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setStatus("error", "File exceeds the 5 MB prototype limit.", ["Choose a smaller CSV file."]);
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", function () {
      validateAndRender(String(reader.result || ""));
    });
    reader.addEventListener("error", function () {
      setStatus("error", "The selected file could not be read.", ["Try selecting the CSV again."]);
    });
    reader.readAsText(file);
  }

  function clearPreview() {
    document.getElementById("csv-input").value = "";
    document.getElementById("preview-panel").hidden = true;
    document.getElementById("clear-csv").disabled = true;
    setStatus("idle", "Choose a CSV file to begin local validation.", [
      "CSV header and required fields",
      "Missing values and numeric readings",
      "Sample preview · first 6 rows"
    ]);
  }

  function downloadSample() {
    const content = [
      expectedHeaders.join(","),
      "2026-11-05T10:00:00,782,45.2,617,2586.3,1596,1725,online",
      "2026-11-05T10:15:00,755,44.7,619,2494.4,1544,1660,online"
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "solarsense-sample-readings.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    const input = document.getElementById("csv-input");
    const dropZone = document.getElementById("drop-zone");

    document.getElementById("choose-csv").addEventListener("click", function (event) {
      event.stopPropagation();
      input.click();
    });
    dropZone.addEventListener("click", function (event) {
      if (event.target !== document.getElementById("choose-csv")) input.click();
    });
    dropZone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", function () { readFile(input.files[0]); });
    dropZone.addEventListener("dragover", function (event) {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
    dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("is-dragging"); });
    dropZone.addEventListener("drop", function (event) {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
      readFile(event.dataTransfer.files[0]);
    });
    document.getElementById("clear-csv").addEventListener("click", clearPreview);
    document.getElementById("download-sample").addEventListener("click", downloadSample);
  }

  window.SolarSenseDataManagement = { activate: initialize };
})();
