import { supabase } from "./supabase";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Chart } from "chart.js/auto";
import H2knowLogo from "../assets/img/H2knowLogo.jpg";

// ─── Brand Color Constants (RGB) ──────────────────────────────────────────────
const C = {
  primary:  [12,  76,  124],   // #0C4C7C - Dark Blue
  accent:   [0,  180,  216],   // #00B4D8 - Cyan
  danger:   [220, 38,  38],    // #DC2626 - Red
  warning:  [217,119,   6],    // #D97706 - Orange
  safe:     [22, 163,  74],    // #16A34A - Green
  muted:    [100,116, 139],    // #64748B - Gray
  lightBg:  [240,249, 255],    // #F0F9FF - Light Background Tint
  rule:     [226,232, 240],    // #E2E8F0 - Border color
  black:    [0,   0,   0],
  white:    [255,255, 255],
};

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ─── Chart Dimensions (explicit mm sizing) ────────────────────────────────────
const CHART_W = 170;
const CHART_H = 85;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");

const formatDate = (isoStr) => {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
};

const formatDateOnly = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
};

const formatTimeOnly = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const setColor = (doc, rgb, type = "text") => {
  if (type === "text") doc.setTextColor(...rgb);
  else if (type === "draw") doc.setDrawColor(...rgb);
  else if (type === "fill") doc.setFillColor(...rgb);
};

const resetTextColor = (doc) => doc.setTextColor(...C.black);

// Draw a horizontal rule
const hRule = (doc, y, color = C.rule, lw = 0.3) => {
  doc.setLineWidth(lw);
  setColor(doc, color, "draw");
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  doc.setLineWidth(0.2);
  setColor(doc, C.black, "draw");
};

// ─── Smart Data Aggregation ────────────────────────────────────────────────────

const aggregateReadingsByDay = (readings) => {
  if (readings.length <= 30) return readings; // No aggregation needed for short ranges

  const dailyMap = new Map();

  readings.forEach((r) => {
    const date = new Date(r.recorded_at);
    const dateKey = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const value = Number(r.value);

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, { values: [], min: value, max: value, sum: 0, count: 0 });
    }

    const dayData = dailyMap.get(dateKey);
    dayData.values.push(value);
    dayData.min = Math.min(dayData.min, value);
    dayData.max = Math.max(dayData.max, value);
    dayData.sum += value;
    dayData.count += 1;
  });

  // Convert map to aggregated readings (use mid-day timestamp)
  const aggregated = [];
  dailyMap.forEach((data, dateKey) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    const midDayTimestamp = new Date(year, month - 1, day, 12, 0, 0).toISOString();
    const avg = data.sum / data.count;

    aggregated.push({
      parameter_id: readings[0].parameter_id,
      value: avg,
      recorded_at: midDayTimestamp,
      _aggregated: true,
      _min: data.min,
      _max: data.max,
    });
  });

  return aggregated.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
};

// ─── Stats calculator ─────────────────────────────────────────────────────────

const calculateStats = (readings, paramNames, parameterMap, unitMap) => {
  const stats = {};
  paramNames.forEach((name) => {
    const paramId = Object.entries(parameterMap).find(([, n]) => n === name)?.[0];
    const paramReadings = readings.filter((r) => r.parameter_id === paramId);
    const values = paramReadings.map((r) => Number(r.value)).filter((v) => !isNaN(v));
    const unit = unitMap?.[paramId] || "";
    if (values.length === 0) {
      stats[name] = { count: 0, avg: "—", min: "—", max: "—", latest: "—", unit };
    } else {
      const sorted = [...paramReadings].sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
      stats[name] = {
        count: values.length,
        avg: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
        min: Math.min(...values).toFixed(2),
        max: Math.max(...values).toFixed(2),
        latest: String(sorted[0]?.value ?? "—"),
        unit,
      };
    }
  });
  return stats;
};

// ─── Chart renderer with smart aggregation ─────────────────────────────────────

const renderSingleChart = async (readings, paramName, parameterMap) => {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 600;
  canvas.style.position = "absolute";
  canvas.style.left = "-9999px";
  document.body.appendChild(canvas);

  const paramId = Object.entries(parameterMap).find(([, n]) => n === paramName)?.[0];
  const sorted = readings
    .filter((r) => r.parameter_id === paramId)
    .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

  // Apply smart aggregation
  const aggregatedReadings = aggregateReadingsByDay(sorted);
  const isAggregated = aggregatedReadings.length !== sorted.length;

  const points = aggregatedReadings.map((r) => ({
    x: new Date(r.recorded_at).getTime(),
    y: Number(r.value),
  }));

  // Format tick labels based on aggregation
  const formatTick = (val) => {
    const d = new Date(val);
    if (isAggregated) {
      return `${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
    } else {
      return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  };

  const chart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [{
        label: paramName,
        data: points,
        borderColor: "#0C4C7C",
        backgroundColor: "rgba(12,76,124,0.08)",
        tension: 0.3,
        pointRadius: isAggregated ? 4 : 3,
        pointBackgroundColor: "#0C4C7C",
        fill: true,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: true,
          text: `${paramName} Over Time${isAggregated ? " (Daily Averages)" : ""}`,
          font: { size: 16, weight: "bold" },
          color: "#0C4C7C",
        },
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            title: (items) => {
              const ts = items[0]?.raw?.x;
              if (typeof ts === "number") {
                const d = new Date(ts);
                if (isAggregated) {
                  return `${pad(d.getMonth()+1)}/${pad(d.getDate())}/${d.getFullYear()}`;
                }
                return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
              }
              return "";
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          grid: { color: "rgba(200,200,200,0.3)" },
          ticks: {
            maxRotation: isAggregated ? 0 : 45,
            callback: formatTick,
          },
          title: { display: true, text: isAggregated ? "Date" : "Date / Time" },
        },
        y: {
          beginAtZero: false,
          grid: { color: "rgba(200,200,200,0.3)" },
          title: { display: true, text: "Value" },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  const imageDataUrl = canvas.toDataURL("image/png");
  chart.destroy();
  document.body.removeChild(canvas);
  return imageDataUrl;
};

// Render multi-parameter comparison chart (bar chart)
const renderComparisonChart = async (readings, paramNames, parameterMap) => {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 600;
  canvas.style.position = "absolute";
  canvas.style.left = "-9999px";
  document.body.appendChild(canvas);

  const datasets = paramNames.map((name, idx) => {
    const paramId = Object.entries(parameterMap).find(([, n]) => n === name)?.[0];
    const paramReadings = readings.filter((r) => r.parameter_id === paramId);
    const values = paramReadings.map((r) => Number(r.value)).filter((v) => !isNaN(v));
    const avg = values.length > 0 ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : 0;

    const colors = ["#0C4C7C", "#00B4D8", "#16A34A", "#D97706", "#DC2626"];
    return {
      label: name,
      data: [avg],
      backgroundColor: colors[idx % colors.length],
      borderColor: colors[idx % colors.length],
      borderWidth: 2,
    };
  });

  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Average Values"],
      datasets,
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: true,
          text: "Parameter Comparison — Average Values",
          font: { size: 16, weight: "bold" },
          color: "#0C4C7C",
        },
        legend: { position: "top" },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: "rgba(200,200,200,0.3)" },
          title: { display: true, text: "Average Value" },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  const imageDataUrl = canvas.toDataURL("image/png");
  chart.destroy();
  document.body.removeChild(canvas);
  return imageDataUrl;
};

// ─── Logo loading helper ───────────────────────────────────────────────────────

const loadLogoAsBase64 = () => {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = H2knowLogo;
  });
};

// ─── Logo embedding helper ────────────────────────────────────────────────────

const addLogoWithAspectRatio = (doc, logoBase64, x, y, maxWidth, maxHeight) => {
  if (!logoBase64) return false;

  try {
    // Extract image dimensions from base64
    const img = new Image();
    img.src = logoBase64;

    // Calculate aspect ratio
    const aspectRatio = img.width / img.height;
    let width = maxWidth;
    let height = width / aspectRatio;

    if (height > maxHeight) {
      height = maxHeight;
      width = height * aspectRatio;
    }

    // Center the image
    const centeredX = x + (maxWidth - width) / 2;
    const centeredY = y + (maxHeight - height) / 2;

    doc.addImage(logoBase64, "PNG", centeredX, centeredY, width, height);
    return true;
  } catch (e) {
    console.warn("Failed to embed logo with aspect ratio:", e);
    return false;
  }
};

// ─── Footer writer (called after all pages are built) ─────────────────────────

const writeFooters = (doc, totalPages) => {
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    const footerY = PAGE_H - 10;

    // Rule above footer
    hRule(doc, footerY - 4, C.rule, 0.3);

    doc.setFontSize(7.5);

    // Left
    setColor(doc, C.muted, "text");
    doc.text("H2Know Environmental Monitoring — Dicklum River Basin", MARGIN, footerY);

    // Center
    setColor(doc, C.muted, "text");
    doc.text("CONFIDENTIAL — Official Regional Submission", PAGE_W / 2, footerY, { align: "center" });

    // Right
    setColor(doc, C.muted, "text");
    doc.text(`Page ${i} of ${totalPages}`, PAGE_W - MARGIN, footerY, { align: "right" });

    resetTextColor(doc);
  }
};

// ─── Page 1: Modern Minimalist Cover Page ─────────────────────────────────────

const buildCoverPage = (doc, form, authorName, logoBase64) => {
  // Subtle background tint (top to bottom gradient simulation)
  setColor(doc, C.lightBg, "fill");
  doc.rect(0, 0, PAGE_W, PAGE_H, "F");

  // Top rule
  hRule(doc, MARGIN, C.primary, 0.8);

  let y = MARGIN + 10;

  // Header Branding - Logo with proper aspect ratio
  const logoSuccess = addLogoWithAspectRatio(doc, logoBase64, PAGE_W / 2 - 25, y, 50, 50);

  if (!logoSuccess) {
    // Fallback placeholder
    setColor(doc, C.primary, "fill");
    doc.roundedRect(PAGE_W / 2 - 15, y, 30, 30, 3, 3, "F");
    setColor(doc, C.white, "text");
    doc.setFontSize(8);
    doc.setFont(undefined, "bold");
    doc.text("H2", PAGE_W / 2, y + 13, { align: "center" });
    doc.setFontSize(6);
    doc.text("LOGO", PAGE_W / 2, y + 20, { align: "center" });
    resetTextColor(doc);
  }

  y += 55;

  // Brand name in uppercase tracking
  doc.setFontSize(11);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("H2KNOW ENVIRONMENTAL MONITORING", PAGE_W / 2, y, { align: "center" });
  y += 15;

  // Main Title
  doc.setFontSize(28);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("ENVIRONMENTAL FIELD REPORT", PAGE_W / 2, y, { align: "center" });
  y += 12;

  // Subtitle
  doc.setFontSize(12);
  doc.setFont(undefined, "normal");
  setColor(doc, C.accent, "text");
  doc.text("Dicklum River Basin Telemetry & Water Quality Audit", PAGE_W / 2, y, { align: "center" });
  y += 8;

  // Dynamic report name
  doc.setFontSize(14);
  doc.setFont(undefined, "bold");
  setColor(doc, C.black, "text");
  doc.text(form.name || "Water Quality Report", PAGE_W / 2, y, { align: "center" });
  y += 10;

  // Report period
  doc.setFontSize(10);
  doc.setFont(undefined, "normal");
  setColor(doc, C.muted, "text");
  doc.text(
    `Report Period: ${form.startDate} to ${form.endDate}`,
    PAGE_W / 2, y, { align: "center" }
  );
  y += 8;

  // Generated timestamp
  const generatedAt = new Date().toISOString();
  doc.setFontSize(8);
  doc.text(
    `Generated: ${formatDate(generatedAt)} ${formatTimeOnly(generatedAt)}`,
    PAGE_W / 2, y, { align: "center" }
  );
  y += 30;

  // Decorative divider
  setColor(doc, C.accent, "fill");
  doc.rect(PAGE_W / 2 - 30, y, 60, 2, "F");
  y += 15;

  // Footer Metadata Block
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.black, "text");
  doc.text(`Prepared by: ${authorName || "Station Lead"}`, PAGE_W / 2, y, { align: "center" });
  y += 7;
  doc.text("Northern Bukidnon State College — DRRM Unit", PAGE_W / 2, y, { align: "center" });
  y += 7;
  doc.setFontSize(8);
  setColor(doc, C.muted, "text");
  doc.text("Station Coordinates: 8.3819°N, 124.8450°E | Dicklum, Manolo Fortich", PAGE_W / 2, y, { align: "center" });
  y += 7;
  doc.setFontSize(9);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("Official Submission Copy — Regional Office Review", PAGE_W / 2, y, { align: "center" });
  resetTextColor(doc);

  // Bottom rule
  hRule(doc, PAGE_H - MARGIN, C.primary, 0.8);
};

// ─── Page 2: Executive Summary & Watershed Analysis (Stacked Layout) ───────

const buildExecutiveSummaryPage = async (doc, form, readings, paramNames, parameterMap, unitMap, aiInsights, weatherSummary, logoBase64) => {
  doc.addPage();
  let y = MARGIN;

  // Page Header Banner with Logo
  setColor(doc, C.primary, "fill");
  doc.rect(MARGIN, y, CONTENT_W, 12, "F");
  setColor(doc, C.white, "text");
  doc.setFontSize(13);
  doc.setFont(undefined, "bold");
  doc.text("EXECUTIVE SUMMARY & WATERSHED ANALYSIS", MARGIN + 4, y + 8);
  resetTextColor(doc);

  // Add small logo in header
  if (logoBase64) {
    try {
      doc.addImage(logoBase64, "PNG", PAGE_W - MARGIN - 12, y + 2, 8, 8);
    } catch (e) {
      // Silently fail
    }
  }

  y += 17;

  // Sub-header
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.muted, "text");
  doc.text(
    `Period: ${form.startDate} to ${form.endDate}   |   Parameters: ${paramNames.length}   |   Total Readings: ${readings.length}`,
    MARGIN, y
  );
  resetTextColor(doc);
  y += 10;

  // ── Key Metrics Banner (Top) ──
  const stats = calculateStats(readings, paramNames, parameterMap, unitMap);
  const firstParam = paramNames[0];
  const firstStats = stats[firstParam];

  setColor(doc, C.primary, "fill");
  doc.roundedRect(MARGIN, y, CONTENT_W, 25, 3, 3, "F");

  setColor(doc, C.white, "text");
  doc.setFontSize(9);
  doc.setFont(undefined, "bold");
  doc.text("KEY METRICS", MARGIN + 4, y + 8);
  let metricsY = y + 15;

  if (firstStats) {
    doc.setFontSize(13);
    doc.setFont(undefined, "bold");
    doc.text(`${firstStats.latest} ${firstStats.unit}`, MARGIN + 4, metricsY);
    metricsY += 7;
    doc.setFontSize(8);
    doc.setFont(undefined, "normal");
    doc.text(`${firstParam} — Latest Reading`, MARGIN + 4, metricsY);
    metricsY += 7;

    // Additional stats on the right side
    const rightX = MARGIN + 70;
    doc.setFontSize(7);
    doc.text(`Avg: ${firstStats.avg} ${firstStats.unit}`, rightX, y + 10);
    doc.text(`Min: ${firstStats.min} ${firstStats.unit}`, rightX, y + 17);
    doc.text(`Max: ${firstStats.max} ${firstStats.unit}`, rightX, y + 24);

    // Status badge
    const statusColor = C.safe;
    const badgeX = MARGIN + 130;
    const badgeW = 28;
    setColor(doc, statusColor, "fill");
    doc.roundedRect(badgeX, y + 12, badgeW, 8, 2, 2, "F");
    setColor(doc, C.white, "text");
    doc.setFontSize(7);
    doc.setFont(undefined, "bold");
    doc.text("NORMAL", badgeX + badgeW / 2, y + 17, { align: "center" });
  }

  resetTextColor(doc);
  y += 32;

  // ── Full-Width Parameter Trend Chart ──
  setColor(doc, C.rule, "draw");
  doc.setLineWidth(0.5);
  doc.rect(MARGIN, y, CONTENT_W, CHART_H);
  doc.setLineWidth(0.2);
  setColor(doc, C.black, "draw");

  doc.setFontSize(10);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("Primary Parameter Trend", MARGIN + 4, y + 6);
  resetTextColor(doc);

  // Render first parameter chart with full width
  if (paramNames.length > 0) {
    const chartImage = await renderSingleChart(readings, paramNames[0], parameterMap);
    if (chartImage) {
      doc.addImage(chartImage, "PNG", MARGIN + 4, y + 10, CONTENT_W - 8, CHART_H - 14);
    }
  }

  y += CHART_H + 10;

  // ── AI Watershed Analysis Block ──
  if (aiInsights) {
    // AI Insights title banner
    setColor(doc, C.accent, "fill");
    doc.rect(MARGIN, y, CONTENT_W, 8, "F");
    setColor(doc, C.white, "text");
    doc.setFontSize(10);
    doc.setFont(undefined, "bold");
    doc.text("AI-POWERED WATERSHED ANALYSIS", MARGIN + 4, y + 5.5);
    resetTextColor(doc);
    y += 13;

    // Overview text
    if (aiInsights.currentInterpretation?.overview) {
      doc.setFontSize(9);
      doc.setFont(undefined, "normal");
      setColor(doc, C.black, "text");
      const lines = doc.splitTextToSize(aiInsights.currentInterpretation.overview, CONTENT_W - 5);
      doc.text(lines, MARGIN, y);
      y += lines.length * 5 + 5;
    }

    // Runoff risk badge
    const riskLevel = (aiInsights.riskLevel || "").toUpperCase();
    let riskColor = C.safe;
    if (riskLevel === "HIGH" || riskLevel === "SEVERE") riskColor = C.danger;
    else if (riskLevel === "MODERATE") riskColor = C.warning;

    doc.setFontSize(9);
    doc.setFont(undefined, "bold");
    setColor(doc, C.black, "text");
    doc.text("Runoff Risk:", MARGIN, y);
    const badgeX = MARGIN + 24;
    const labelW = doc.getTextWidth(riskLevel) + 6;
    setColor(doc, riskColor, "fill");
    doc.roundedRect(badgeX, y - 4.5, labelW, 6, 1.5, 1.5, "F");
    setColor(doc, C.white, "text");
    doc.setFontSize(8);
    doc.text(riskLevel || "—", badgeX + 3, y - 0.3);
    resetTextColor(doc);
    y += 9;

    // Key observations
    const observations = aiInsights.currentInterpretation?.keyObservations || [];
    if (observations.length > 0) {
      doc.setFontSize(9);
      doc.setFont(undefined, "bold");
      setColor(doc, C.primary, "text");
      doc.text("Key Observations:", MARGIN, y);
      y += 5;
      doc.setFont(undefined, "normal");
      setColor(doc, C.black, "text");
      observations.slice(0, 3).forEach((obs) => {
        const lines = doc.splitTextToSize(`• ${obs}`, CONTENT_W - 5);
        doc.text(lines, MARGIN + 3, y);
        y += lines.length * 5 + 1;
      });
      y += 3;
    }

    // Weather forecast
    if (weatherSummary) {
      doc.setFontSize(9);
      doc.setFont(undefined, "bold");
      setColor(doc, C.primary, "text");
      doc.text("7-Day Forecast:", MARGIN, y);
      doc.setFont(undefined, "normal");
      setColor(doc, C.black, "text");
      y += 5;
      const rainMm = weatherSummary.next7DaysRainMm ?? "—";
      const precipProb = weatherSummary.next7DaysPrecipProbMax ?? "—";
      doc.text(
        `Expected Rainfall: ${rainMm} mm | Max Precipitation Probability: ${precipProb}%`,
        MARGIN, y
      );
      y += 8;
    }

    // Immediate recommendations
    const immediateRecs = aiInsights.recommendations?.immediate || [];
    if (immediateRecs.length > 0) {
      doc.setFontSize(9);
      doc.setFont(undefined, "bold");
      setColor(doc, C.primary, "text");
      doc.text("Immediate Recommendations:", MARGIN, y);
      y += 5;
      doc.setFont(undefined, "normal");
      setColor(doc, C.black, "text");
      immediateRecs.slice(0, 2).forEach((rec) => {
        const lines = doc.splitTextToSize(`→ ${rec}`, CONTENT_W - 5);
        doc.text(lines, MARGIN + 3, y);
        y += lines.length * 5 + 1;
      });
    }

    resetTextColor(doc);
  }
};

// ─── Page 3: Parameter Comparison & Aggregated Summaries ──────────────────────

const buildParameterComparisonPage = async (doc, form, readings, paramNames, parameterMap, unitMap) => {
  doc.addPage();
  let y = MARGIN;

  // Page Header Banner
  setColor(doc, C.primary, "fill");
  doc.rect(MARGIN, y, CONTENT_W, 12, "F");
  setColor(doc, C.white, "text");
  doc.setFontSize(13);
  doc.setFont(undefined, "bold");
  doc.text("PARAMETER COMPARISON & AGGREGATED SUMMARIES", MARGIN + 4, y + 8);
  resetTextColor(doc);
  y += 17;

  // Sub-header
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.muted, "text");
  doc.text(
    `Period: ${form.startDate} to ${form.endDate}   |   Parameters: ${paramNames.length}`,
    MARGIN, y
  );
  resetTextColor(doc);
  y += 10;

  // ── Comparison Chart (Bar Chart) ──
  if (paramNames.length > 1) {
    doc.setFontSize(10);
    doc.setFont(undefined, "bold");
    setColor(doc, C.primary, "text");
    doc.text("Average Values Comparison", MARGIN, y);
    resetTextColor(doc);
    y += 5;

    const comparisonChart = await renderComparisonChart(readings, paramNames, parameterMap);
    if (comparisonChart) {
      doc.addImage(comparisonChart, "PNG", MARGIN, y, CHART_W, CHART_H);
      y += CHART_H + 8;
    }
  }

  // ── Summary Statistics Table ──
  const stats = calculateStats(readings, paramNames, parameterMap, unitMap);

  doc.setFontSize(10);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("Aggregated Parameter Statistics", MARGIN, y);
  resetTextColor(doc);
  y += 5;

  const tableBody = paramNames.map((name) => {
    const s = stats[name];
    return [
      name,
      s.unit,
      s.avg,
      s.min,
      s.max,
      s.count,
      s.count > 0 ? "Normal" : "—",
    ];
  });

  autoTable(doc, {
    startY: y,
    head: [["Parameter", "Unit", "Average", "Min", "Max", "Readings", "Status"]],
    body: tableBody,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [240, 249, 255] },
    columnStyles: {
      0: { fontStyle: "bold" },
      6: {
        fontStyle: "bold",
        textColor: C.safe,
      },
    },
    didParseCell: (data) => {
      if (data.column.index === 6 && data.section === "body") {
        const val = data.cell.raw;
        if (val === "Normal") {
          data.cell.styles.textColor = C.safe;
        } else {
          data.cell.styles.textColor = C.muted;
        }
      }
    },
    margin: { left: MARGIN, right: MARGIN },
  });

  y = doc.lastAutoTable.finalY + 10;

  // Note about raw data
  doc.setFontSize(8);
  setColor(doc, C.muted, "text");
  doc.text(
    "Note: Detailed time-series data (50+ readings per parameter) is available in the CSV export.",
    MARGIN, y
  );
  resetTextColor(doc);
};

// ─── Page 4: Regional Certification & Sign-Off Block ─────────────────────────

const buildCertificationPage = (doc, form, authorName, logoBase64) => {
  doc.addPage();
  let y = MARGIN;

  // Page header banner
  setColor(doc, C.primary, "fill");
  doc.rect(MARGIN, y, CONTENT_W, 12, "F");
  setColor(doc, C.white, "text");
  doc.setFontSize(13);
  doc.setFont(undefined, "bold");
  doc.text("REGIONAL CERTIFICATION & SIGN-OFF", MARGIN + 4, y + 8);
  resetTextColor(doc);

  // Add small logo in header
  if (logoBase64) {
    try {
      doc.addImage(logoBase64, "PNG", PAGE_W - MARGIN - 12, y + 2, 8, 8);
    } catch (e) {
      // Silently fail
    }
  }

  y += 17;

  // Title
  doc.setFontSize(12);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("Official Certification and Acknowledgment", PAGE_W / 2, y, { align: "center" });
  y += 10;

  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.black, "text");
  const certText = "This environmental field report has been prepared in accordance with regional DRRM standards and submitted for official review.";
  const lines = doc.splitTextToSize(certText, CONTENT_W - 10);
  doc.text(lines, PAGE_W / 2, y, { align: "center" });
  y += lines.length * 5 + 25;

  // 3-Column Signature Block
  const colWidth = CONTENT_W / 3;
  const col1X = MARGIN;
  const col2X = MARGIN + colWidth;
  const col3X = MARGIN + colWidth * 2;

  // Column 1: Station Lead
  doc.setFontSize(10);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("Station Lead", col1X + colWidth / 2, y, { align: "center" });
  y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.black, "text");
  doc.text(authorName || "Station Officer", col1X + colWidth / 2, y, { align: "center" });
  y += 5;
  doc.text("Northern Bukidnon State College", col1X + colWidth / 2, y, { align: "center" });
  y += 15;

  // Signature line
  hRule(doc, y, C.black, 0.5);
  y += 5;
  doc.setFontSize(8);
  setColor(doc, C.muted, "text");
  doc.text("Signature over Printed Name", col1X + colWidth / 2, y, { align: "center" });
  y += 8;
  doc.text("Date: _______________", col1X + colWidth / 2, y, { align: "center" });
  resetTextColor(doc);

  // Column 2: NBSC Coordinator
  let col2Y = y - 33;
  doc.setFontSize(10);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("NBSC Coordinator", col2X + colWidth / 2, col2Y, { align: "center" });
  col2Y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.black, "text");
  doc.text("DRRM Coordinator", col2X + colWidth / 2, col2Y, { align: "center" });
  col2Y += 5;
  doc.text("Northern Bukidnon State College", col2X + colWidth / 2, col2Y, { align: "center" });
  col2Y += 15;

  // Signature line
  hRule(doc, col2Y, C.black, 0.5);
  col2Y += 5;
  doc.setFontSize(8);
  setColor(doc, C.muted, "text");
  doc.text("Signature over Printed Name", col2X + colWidth / 2, col2Y, { align: "center" });
  col2Y += 8;
  doc.text("Date: _______________", col2X + colWidth / 2, col2Y, { align: "center" });
  resetTextColor(doc);

  // Column 3: Regional Director
  let col3Y = y - 33;
  doc.setFontSize(10);
  doc.setFont(undefined, "bold");
  setColor(doc, C.primary, "text");
  doc.text("Regional Director", col3X + colWidth / 2, col3Y, { align: "center" });
  col3Y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  setColor(doc, C.black, "text");
  doc.text("Regional Office Director", col3X + colWidth / 2, col3Y, { align: "center" });
  col3Y += 5;
  doc.text("DRRM Regional Office", col3X + colWidth / 2, col3Y, { align: "center" });
  col3Y += 15;

  // Signature line
  hRule(doc, col3Y, C.black, 0.5);
  col3Y += 5;
  doc.setFontSize(8);
  setColor(doc, C.muted, "text");
  doc.text("Signature over Printed Name", col3X + colWidth / 2, col3Y, { align: "center" });
  col3Y += 8;
  doc.text("Date: _______________", col3X + colWidth / 2, col3Y, { align: "center" });
  resetTextColor(doc);

  y = col3Y + 25;

  // Official Stamp Placeholder
  const stampX = PAGE_W / 2 - 25;
  const stampY = y;
  setColor(doc, C.rule, "draw");
  doc.setLineWidth(0.5);
  doc.rect(stampX, stampY, 50, 50);
  doc.setLineWidth(0.2);
  setColor(doc, C.black, "draw");

  doc.setFontSize(8);
  doc.setFont(undefined, "bold");
  setColor(doc, C.muted, "text");
  doc.text("OFFICIAL STAMP", stampX + 25, stampY + 25, { align: "center" });
  doc.setFont(undefined, "normal");
  doc.text("PLACEHOLDER", stampX + 25, stampY + 32, { align: "center" });
  resetTextColor(doc);

  y = stampY + 60;

  // Footer note
  doc.setFontSize(8);
  setColor(doc, C.muted, "text");
  doc.text(
    "This document is an official environmental field report prepared for regional DRRM submission.",
    PAGE_W / 2, y, { align: "center" }
  );
  resetTextColor(doc);
};

// ─── CSV builder ─────────────────────────────────────────────────────────────

const buildCsv = (readings, parameterMap, unitMap, paramNames) => {
  const stats = calculateStats(readings, paramNames, parameterMap, unitMap);
  const summaryLines = paramNames.map((name) => {
    const s = stats[name];
    return `# ${name}: ${s.count} readings, avg=${s.avg} ${s.unit}, min=${s.min} ${s.unit}, max=${s.max} ${s.unit}`;
  });
  const summaryHeader = `# Report summary - Total readings: ${readings.length}\n` + summaryLines.join("\n") + "\n";
  const header = "Date,Time,Parameter,Value,Unit\n";
  const lines = readings.map((row) => {
    const d = row.recorded_at ? new Date(row.recorded_at) : null;
    const dateStr = d
      ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`
      : "";
    const timeStr = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
    const paramName = parameterMap[row.parameter_id] || "Unknown";
    const unit = unitMap?.[row.parameter_id] || "";
    return `${dateStr},${timeStr},"${paramName}",${row.value ?? ""},"${unit}"`;
  }).join("\n");
  return new Blob([summaryHeader + header + lines], { type: "text/csv" });
};

// ─── Main PDF builder ─────────────────────────────────────────────────────────

const buildPdf = async (form, readings, paramNames, parameterMap, unitMap, authorName, aiInsights, weatherSummary, logoBase64) => {
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  // Load logo from public folder if not provided
  const finalLogoBase64 = logoBase64 || await loadLogoAsBase64();

  // Page 1 — Cover
  buildCoverPage(doc, form, authorName, finalLogoBase64);

  // Page 2 — Executive Summary & Watershed Analysis (Stacked Layout)
  await buildExecutiveSummaryPage(doc, form, readings, paramNames, parameterMap, unitMap, aiInsights, weatherSummary, finalLogoBase64);

  // Page 3 — Parameter Comparison & Aggregated Summaries
  await buildParameterComparisonPage(doc, form, readings, paramNames, parameterMap, unitMap);

  // Page 4 — Certification & Sign-Off
  buildCertificationPage(doc, form, authorName, finalLogoBase64);

  // Stamp footers on every page now that we know total count
  const totalPages = doc.internal.pages.length - 1;
  writeFooters(doc, totalPages);

  return doc.output("blob");
};

// ─── Public export ────────────────────────────────────────────────────────────

export const generateReportFile = async ({
  form,
  parameters,
  reportId,
  authorName,
  aiInsights,
  weatherSummary,
}) => {
  const selectedIds = form.parameterIds.includes("all")
    ? parameters.map((p) => p.id)
    : form.parameterIds;

  const parameterMap = Object.fromEntries(parameters.map((p) => [p.id, p.name]));
  const unitMap = Object.fromEntries(parameters.map((p) => [p.id, p.unit || ""]));
  const paramNames = selectedIds.map((id) => parameterMap[id]).filter(Boolean);

  const { data: readings, error: readingsError } = await supabase
    .from("sensor_readings")
    .select("parameter_id, value, recorded_at")
    .in("parameter_id", selectedIds)
    .gte("recorded_at", `${form.startDate}T00:00:00`)
    .lte("recorded_at", `${form.endDate}T23:59:59`);

  if (readingsError) throw readingsError;

  const sortedReadings = (readings || []).sort(
    (a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)
  );

  let fileBlob;
  let extension;

  if (form.format === "pdf") {
    fileBlob = await buildPdf(
      form,
      sortedReadings,
      paramNames,
      parameterMap,
      unitMap,
      authorName,
      aiInsights ?? null,
      weatherSummary ?? null,
      null // logoBase64 will be loaded internally
    );
    extension = "pdf";
  } else {
    fileBlob = buildCsv(sortedReadings, parameterMap, unitMap, paramNames);
    extension = "csv";
  }

  const filePath = `reports/${reportId}.${extension}`;
  const { error: uploadError } = await supabase.storage
    .from("reports")
    .upload(filePath, fileBlob, {
      upsert: true,
      contentType: form.format === "pdf" ? "application/pdf" : "text/csv",
    });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage.from("reports").getPublicUrl(filePath);
  return { url: publicUrlData.publicUrl, blob: fileBlob };
};
