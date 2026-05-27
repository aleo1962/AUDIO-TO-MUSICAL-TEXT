const audioInput = document.querySelector("#audioInput");
const audioPlayer = document.querySelector("#audioPlayer");
const analyzeButton = document.querySelector("#analyzeButton");
const demoButton = document.querySelector("#demoButton");
const resetButton = document.querySelector("#resetButton");
const dropZone = document.querySelector("#dropZone");
const fileName = document.querySelector("#fileName");
const tempoInput = document.querySelector("#tempoInput");
const keySelect = document.querySelector("#keySelect");
const sensitivityInput = document.querySelector("#sensitivityInput");
const gridSelect = document.querySelector("#gridSelect");
const scoreCanvas = document.querySelector("#scoreCanvas");
const statusTitle = document.querySelector("#statusTitle");
const statusDetail = document.querySelector("#statusDetail");
const progressBar = document.querySelector("#progressBar");
const playMelodyButton = document.querySelector("#playMelodyButton");
const downloadXmlButton = document.querySelector("#downloadXmlButton");
const downloadSvgButton = document.querySelector("#downloadSvgButton");
const noteCount = document.querySelector("#noteCount");
const rangeText = document.querySelector("#rangeText");
const durationText = document.querySelector("#durationText");
const confidenceText = document.querySelector("#confidenceText");

let currentFile = null;
let currentBuffer = null;
let currentNotes = [];
let currentSvg = "";
let currentXml = "";

const pitchNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const italianNames = {
  C: "Do",
  "C#": "Do#",
  D: "Re",
  "D#": "Re#",
  E: "Mi",
  F: "Fa",
  "F#": "Fa#",
  G: "Sol",
  "G#": "Sol#",
  A: "La",
  "A#": "La#",
  B: "Si",
};

function setStatus(title, detail, progress = 0) {
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqToMidi(freq) {
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

function midiToName(midi) {
  const name = pitchNames[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${italianNames[name] ?? name}${octave}`;
}

function noteStep(midi) {
  const name = pitchNames[((midi % 12) + 12) % 12];
  return {
    step: name.replace("#", ""),
    alter: name.includes("#") ? 1 : 0,
    octave: Math.floor(midi / 12) - 1,
    accidental: name.includes("#"),
  };
}

function getMonoData(buffer) {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
  }
  return mono;
}

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function detectPitch(frame, sampleRate, threshold) {
  const volume = rms(frame);
  if (volume < threshold) return null;

  const minFreq = 80;
  const maxFreq = 1050;
  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.min(Math.floor(sampleRate / minFreq), frame.length - 1);
  let bestLag = -1;
  let bestCorrelation = 0;
  const candidates = [];

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i < frame.length - lag; i += 1) {
      const a = frame[i];
      const b = frame[i + lag];
      corr += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const norm = corr / Math.sqrt(energyA * energyB || 1);
    if (norm > bestCorrelation) {
      bestCorrelation = norm;
      bestLag = lag;
    }
    candidates.push({ lag, norm });
  }

  if (bestCorrelation < 0.52 || bestLag < 0) return null;

  const strongCandidate = candidates.find((candidate) => candidate.norm > Math.max(0.58, bestCorrelation * 0.92));
  const freq = sampleRate / (strongCandidate?.lag ?? bestLag);
  const midi = freqToMidi(freq);
  if (midi < 40 || midi > 84) return null;

  return {
    freq,
    midi,
    confidence: Math.min(1, (bestCorrelation - 0.45) / 0.45),
    volume,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function waitForUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function analyzeMelody(buffer, options, onProgress) {
  const mono = getMonoData(buffer);
  const sampleRate = buffer.sampleRate;
  const frameSize = 2048;
  const hopSize = 512;
  const frames = [];
  const totalFrames = Math.max(1, Math.floor((mono.length - frameSize) / hopSize));

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const start = frameIndex * hopSize;
    const frame = mono.subarray(start, start + frameSize);
    const pitch = detectPitch(frame, sampleRate, options.sensitivity);
    frames.push({
      time: start / sampleRate,
      midi: pitch?.midi ?? null,
      confidence: pitch?.confidence ?? 0,
      volume: pitch?.volume ?? 0,
    });
    if (frameIndex % 80 === 0) {
      onProgress(25 + (frameIndex / totalFrames) * 35);
    }
    if (frameIndex % 240 === 0) {
      await waitForUi();
    }
  }

  const smoothed = frames.map((frame, index) => {
    const window = frames.slice(Math.max(0, index - 2), Math.min(frames.length, index + 3));
    const values = window.map((item) => item.midi).filter((value) => value !== null);
    if (!values.length) return frame;
    return { ...frame, midi: median(values) };
  });

  const secondsPerBeat = 60 / options.tempo;
  const beatsPerGrid = 4 / options.grid;
  const minDuration = secondsPerBeat * beatsPerGrid * 0.65;
  const notes = [];
  let active = null;

  for (const frame of smoothed) {
    if (frame.midi === null) {
      if (active) {
        active.end = frame.time;
        notes.push(active);
        active = null;
      }
      continue;
    }

    if (!active) {
      active = {
        midi: frame.midi,
        start: frame.time,
        end: frame.time + hopSize / sampleRate,
        confidences: [frame.confidence],
      };
      continue;
    }

    if (Math.abs(active.midi - frame.midi) <= 1) {
      active.midi = Math.round((active.midi * active.confidences.length + frame.midi) / (active.confidences.length + 1));
      active.end = frame.time + hopSize / sampleRate;
      active.confidences.push(frame.confidence);
    } else {
      notes.push(active);
      active = {
        midi: frame.midi,
        start: frame.time,
        end: frame.time + hopSize / sampleRate,
        confidences: [frame.confidence],
      };
    }
  }
  if (active) notes.push(active);

  onProgress(70);

  const quantized = notes
    .map((note) => {
      const qStart = Math.round(note.start / secondsPerBeat / beatsPerGrid) * beatsPerGrid;
      const rawBeats = Math.max(beatsPerGrid, (note.end - note.start) / secondsPerBeat);
      const qBeats = Math.max(beatsPerGrid, Math.round(rawBeats / beatsPerGrid) * beatsPerGrid);
      return {
        midi: note.midi,
        startBeat: qStart,
        durationBeats: qBeats,
        confidence: note.confidences.reduce((sum, value) => sum + value, 0) / note.confidences.length,
      };
    })
    .filter((note) => note.durationBeats * secondsPerBeat >= minDuration);

  const merged = [];
  for (const note of quantized) {
    const previous = merged.at(-1);
    if (previous && previous.midi === note.midi && note.startBeat <= previous.startBeat + previous.durationBeats + beatsPerGrid) {
      previous.durationBeats = Math.max(previous.durationBeats, note.startBeat + note.durationBeats - previous.startBeat);
      previous.confidence = (previous.confidence + note.confidence) / 2;
    } else {
      merged.push(note);
    }
  }

  onProgress(82);
  return merged;
}

function durationSymbol(beats) {
  if (beats >= 3.75) return { name: "whole", label: "semibreve", dots: 0, filled: false };
  if (beats >= 2.75) return { name: "half", label: "minima puntata", dots: 1, filled: false };
  if (beats >= 1.75) return { name: "half", label: "minima", dots: 0, filled: false };
  if (beats >= 1.35) return { name: "quarter", label: "semiminima puntata", dots: 1, filled: true };
  if (beats >= 0.85) return { name: "quarter", label: "semiminima", dots: 0, filled: true };
  if (beats >= 0.65) return { name: "eighth", label: "croma puntata", dots: 1, filled: true };
  if (beats >= 0.42) return { name: "eighth", label: "croma", dots: 0, filled: true };
  return { name: "16th", label: "semicroma", dots: 0, filled: true };
}

function splitStandardDuration(beats, maxBeats) {
  const values = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25];
  return values.find((value) => value <= beats + 0.001 && value <= maxBeats + 0.001) ?? Math.min(beats, maxBeats);
}

function addRestsToCoverDuration(notes, audioDuration, tempo, grid) {
  const secondsPerBeat = 60 / tempo;
  const beatsPerGrid = 4 / grid;
  const totalBeats = Math.ceil(audioDuration / secondsPerBeat / beatsPerGrid) * beatsPerGrid;
  const events = [];
  let cursor = 0;

  for (const note of notes) {
    const startBeat = Math.max(0, note.startBeat);
    const gap = startBeat - cursor;
    if (gap >= beatsPerGrid) {
      events.push({
        rest: true,
        startBeat: cursor,
        durationBeats: Math.round(gap / beatsPerGrid) * beatsPerGrid,
        confidence: 1,
      });
    }
    events.push({ ...note, rest: false });
    cursor = Math.max(cursor, note.startBeat + note.durationBeats);
  }

  const tail = totalBeats - cursor;
  if (tail >= beatsPerGrid) {
    events.push({
      rest: true,
      startBeat: cursor,
      durationBeats: Math.round(tail / beatsPerGrid) * beatsPerGrid,
      confidence: 1,
    });
  }

  return events;
}

function splitIntoNotationEvents(events) {
  const measureBeats = 4;
  const notation = [];

  events.forEach((event, sourceIndex) => {
    let remaining = event.durationBeats;
    let startBeat = event.startBeat;
    const parts = [];

    while (remaining > 0.001) {
      const measurePosition = ((startBeat % measureBeats) + measureBeats) % measureBeats;
      const measureRoom = measurePosition === 0 ? measureBeats : measureBeats - measurePosition;
      const durationBeats = splitStandardDuration(remaining, measureRoom);
      parts.push({
        ...event,
        sourceId: `${event.rest ? "rest" : "note"}-${sourceIndex}`,
        startBeat,
        durationBeats,
      });
      remaining = Math.max(0, remaining - durationBeats);
      startBeat += durationBeats;
    }

    if (!event.rest && parts.length > 1) {
      parts.forEach((part, index) => {
        part.tieStop = index > 0;
        part.tieStart = index < parts.length - 1;
      });
    }

    notation.push(...parts);
  });

  return notation;
}

function prepareNotationEvents(pitchedNotes, audioDuration, options) {
  const beatsPerGrid = 4 / options.grid;
  const annotated = pitchedNotes.map((note, index) => {
    const next = pitchedNotes[index + 1];
    const gap = next ? next.startBeat - (note.startBeat + note.durationBeats) : 0;
    return {
      ...note,
      staccato: note.durationBeats <= 1 && gap >= beatsPerGrid,
    };
  });
  return splitIntoNotationEvents(addRestsToCoverDuration(annotated, audioDuration, options.tempo, options.grid));
}

function staffY(midi, top) {
  const steps = {
    C: 0,
    D: 1,
    E: 2,
    F: 3,
    G: 4,
    A: 5,
    B: 6,
  };
  const info = noteStep(midi);
  const diatonic = info.octave * 7 + steps[info.step];
  const e4 = 4 * 7 + steps.E;
  return top + 40 - (diatonic - e4) * 5;
}

function renderScore(notes, options) {
  const staffWidth = 1040;
  const left = 86;
  const topPad = 60;
  const staffGap = 150;
  const notesPerLine = 18;
  const lines = Math.max(1, Math.ceil(notes.length / notesPerLine));
  const height = topPad + lines * staffGap + 48;
  const width = 1180;
  const measureBeats = 4;
  let body = "";

  body += `<text x="42" y="34" class="score-meta">Voce principale - ${options.key}, ${options.tempo} bpm</text>`;

  for (let line = 0; line < lines; line += 1) {
    const top = topPad + line * staffGap;
    for (let row = 0; row < 5; row += 1) {
      body += `<line x1="42" y1="${top + row * 10}" x2="${staffWidth}" y2="${top + row * 10}" class="staff-line" />`;
    }
    body += `<text x="48" y="${top + 36}" class="score-meta" style="font-size:34px">𝄞</text>`;
    body += `<line x1="${left - 8}" y1="${top}" x2="${left - 8}" y2="${top + 40}" class="bar-line" />`;
  }

  notes.forEach((note, index) => {
    const line = Math.floor(index / notesPerLine);
    const position = index % notesPerLine;
    const top = topPad + line * staffGap;
    const x = left + position * ((staffWidth - left - 26) / notesPerLine) + 18;
    const symbol = durationSymbol(note.durationBeats);

    if (index > 0 && Math.floor(notes[index - 1].startBeat / measureBeats) !== Math.floor(note.startBeat / measureBeats)) {
      body += `<line x1="${x - 18}" y1="${top}" x2="${x - 18}" y2="${top + 40}" class="bar-line" />`;
    }

    if (note.rest) {
      body += `<path d="M${x - 10} ${top + 16} h24 l-8 13 h-24 l8-13Z" class="note-rest" />`;
      return;
    }

    const y = staffY(note.midi, top);
    const stemUp = note.midi < 71;
    const stemY = stemUp ? y - 36 : y + 36;
    const stemX = stemUp ? x + 9 : x - 9;

    if (y < top - 5 || y > top + 45) {
      for (let ledger = y < top ? top - 10 : Number.NEGATIVE_INFINITY; ledger >= y; ledger -= 10) {
        body += `<line x1="${x - 14}" y1="${ledger}" x2="${x + 14}" y2="${ledger}" class="staff-line" />`;
      }
      for (let ledger = y > top + 40 ? top + 50 : Number.POSITIVE_INFINITY; ledger <= y; ledger += 10) {
        body += `<line x1="${x - 14}" y1="${ledger}" x2="${x + 14}" y2="${ledger}" class="staff-line" />`;
      }
    }

    body += `<ellipse cx="${x}" cy="${y}" rx="10" ry="7" transform="rotate(-18 ${x} ${y})" class="note-head" ${symbol.filled ? "" : 'fill="#fffdf8" stroke="#1f2428" stroke-width="2"'} />`;
    if (symbol.name !== "whole") {
      body += `<line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemY}" class="stem" stroke-width="2" />`;
    }
    if (symbol.name === "eighth" || symbol.name === "16th") {
      const flagEnd = stemUp ? stemY + 16 : stemY - 16;
      body += `<path d="M${stemX} ${stemY} C ${stemX + 18} ${stemY + 4}, ${stemX + 17} ${flagEnd}, ${stemX + 3} ${flagEnd}" class="beam" fill="none" stroke-width="2" />`;
    }
    if (noteStep(note.midi).accidental) {
      body += `<text x="${x - 24}" y="${y + 5}" class="note-label" style="font-size:18px">#</text>`;
    }
    if (symbol.dots) {
      body += `<circle cx="${x + 17}" cy="${y - 2}" r="2.2" class="note-head" />`;
    }
    if (note.staccato && !note.tieStart && !note.tieStop) {
      body += `<circle cx="${x}" cy="${stemUp ? y + 18 : y - 18}" r="2.5" class="note-head" />`;
    }
    if (note.tieStart) {
      const nextNote = notes[index + 1];
      const nextLine = Math.floor((index + 1) / notesPerLine);
      if (nextNote && !nextNote.rest && nextLine === line) {
        const nextX = left + ((index + 1) % notesPerLine) * ((staffWidth - left - 26) / notesPerLine) + 18;
        const tieY = y + (stemUp ? 17 : -17);
        body += `<path d="M${x + 12} ${tieY} C ${x + 28} ${tieY + (stemUp ? 10 : -10)}, ${nextX - 28} ${tieY + (stemUp ? 10 : -10)}, ${nextX - 12} ${tieY}" class="tie" />`;
      }
    }
    body += `<text x="${x - 13}" y="${top + 78}" class="note-label">${midiToName(note.midi)}</text>`;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#fffdf8"/>
    ${body}
  </svg>`;
  scoreCanvas.innerHTML = svg;
  return svg;
}

function buildMusicXml(notes, options) {
  const divisions = 8;
  const measureCount = Math.max(1, Math.ceil((notes.at(-1)?.startBeat ?? 0) / 4) + 1);
  const measures = Array.from({ length: measureCount }, () => []);
  notes.forEach((note) => {
    const measureIndex = Math.max(0, Math.floor(note.startBeat / 4));
    measures[measureIndex].push(note);
  });

  const noteToXml = (note) => {
      const duration = Math.max(1, Math.round(note.durationBeats * divisions));
      const type = durationSymbol(note.durationBeats).name;
      const dots = durationSymbol(note.durationBeats).dots ? "<dot/>" : "";
      const tied = `${note.tieStop ? '<tied type="stop"/>' : ""}${note.tieStart ? '<tied type="start"/>' : ""}`;
      const articulations = note.staccato && !note.tieStart && !note.tieStop ? "<articulations><staccato/></articulations>" : "";
      const notations = tied || articulations ? `<notations>${tied}${articulations}</notations>` : "";
      if (note.rest) {
        return `<note>
        <rest/>
        <duration>${duration}</duration>
        <voice>1</voice>
        <type>${type}</type>
        ${dots}
      </note>`;
      }
      const info = noteStep(note.midi);
      return `<note>
        <pitch><step>${info.step}</step>${info.alter ? `<alter>${info.alter}</alter>` : ""}<octave>${info.octave}</octave></pitch>
        ${note.tieStop ? '<tie type="stop"/>' : ""}${note.tieStart ? '<tie type="start"/>' : ""}
        <duration>${duration}</duration>
        <voice>1</voice>
        <type>${type}</type>
        ${dots}
        ${notations}
      </note>`;
  };

  const measureXml = measures
    .map((measure, index) => `<measure number="${index + 1}">
      ${
        index === 0
          ? `<attributes>
        <divisions>${divisions}</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${options.tempo}</per-minute></metronome></direction-type></direction>`
          : ""
      }
      ${measure.map(noteToXml).join("\n")}
    </measure>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Voce principale</part-name></score-part>
  </part-list>
  <part id="P1">
    ${measureXml}
  </part>
</score-partwise>`;
}

function updateInsights(notes, duration, confidence) {
  const pitchedNotes = notes.filter((note) => !note.rest);
  noteCount.textContent = String(pitchedNotes.length);
  if (!pitchedNotes.length) {
    rangeText.textContent = "-";
    durationText.textContent = "-";
    confidenceText.textContent = "-";
    return;
  }
  const midis = pitchedNotes.map((note) => note.midi);
  rangeText.textContent = `${midiToName(Math.min(...midis))} - ${midiToName(Math.max(...midis))}`;
  durationText.textContent = `${duration.toFixed(1)} s`;
  confidenceText.textContent = `${Math.round(confidence * 100)}%`;
}

async function loadAudioFile(file) {
  currentFile = file;
  fileName.textContent = file.name;
  analyzeButton.disabled = false;
  audioPlayer.src = URL.createObjectURL(file);
  audioPlayer.classList.add("has-audio");
  setStatus("File pronto", "Regola i parametri o avvia l'analisi.", 8);
}

async function decodeCurrentFile() {
  if (!currentFile) return null;
  const arrayBuffer = await currentFile.arrayBuffer();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
  await context.close();
  return buffer;
}

async function runAnalysis() {
  if (!currentFile) return;
  analyzeButton.disabled = true;
  playMelodyButton.disabled = true;
  downloadXmlButton.disabled = true;
  downloadSvgButton.disabled = true;
  setStatus("Decodifica", "Sto leggendo l'audio nel browser.", 15);

  try {
    currentBuffer = await decodeCurrentFile();
    setStatus("Ascolto", "Cerco la linea melodica più stabile.", 25);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const options = {
      tempo: Number(tempoInput.value) || 96,
      key: keySelect.value,
      sensitivity: Number(sensitivityInput.value) || 0.16,
      grid: Number(gridSelect.value) || 8,
    };

    const pitchedNotes = await analyzeMelody(currentBuffer, options, (progress) => {
      progressBar.style.width = `${progress}%`;
    });

    if (!pitchedNotes.length) {
      setStatus("Nessuna melodia chiara", "Prova ad abbassare la sensibilità o usa un audio con voce più isolata.", 0);
      updateInsights([], 0, 0);
      return;
    }

    setStatus("Scrittura", "Disegno lo spartito e preparo l'esportazione.", 88);
    currentNotes = prepareNotationEvents(pitchedNotes, currentBuffer.duration, options);
    currentSvg = renderScore(currentNotes, options);
    currentXml = buildMusicXml(currentNotes, options);
    const confidence = pitchedNotes.reduce((sum, note) => sum + note.confidence, 0) / pitchedNotes.length;
    updateInsights(currentNotes, currentBuffer.duration, confidence);
    setStatus("Completato", "Spartito generato. Puoi ascoltare la melodia o scaricare MusicXML/SVG.", 100);
    playMelodyButton.disabled = false;
    downloadXmlButton.disabled = false;
    downloadSvgButton.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus("Errore", "Non riesco a leggere questo file audio nel browser.", 0);
  } finally {
    analyzeButton.disabled = false;
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function playMelody() {
  if (!currentNotes.length) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContext();
  const tempo = Number(tempoInput.value) || 96;
  const secondsPerBeat = 60 / tempo;
  const start = context.currentTime + 0.08;
  currentNotes.filter((note) => !note.rest).slice(0, 80).forEach((note) => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    const t0 = start + note.startBeat * secondsPerBeat;
    const t1 = t0 + Math.max(0.08, note.durationBeats * secondsPerBeat * 0.9);
    osc.type = "sine";
    osc.frequency.value = midiToFreq(note.midi);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.08, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t1);
    osc.connect(gain).connect(context.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  });
}

function resetApp() {
  currentFile = null;
  currentBuffer = null;
  currentNotes = [];
  currentSvg = "";
  currentXml = "";
  audioInput.value = "";
  audioPlayer.removeAttribute("src");
  audioPlayer.classList.remove("has-audio");
  fileName.textContent = "Nessun file caricato";
  analyzeButton.disabled = true;
  playMelodyButton.disabled = true;
  downloadXmlButton.disabled = true;
  downloadSvgButton.disabled = true;
  setStatus("Pronto", "Carica un file per iniziare.", 0);
  updateInsights([], 0, 0);
  scoreCanvas.innerHTML = `<div class="empty-score">
    <svg viewBox="0 0 120 48" aria-hidden="true">
      <path d="M4 9h112M4 16.5h112M4 24h112M4 31.5h112M4 39h112" />
      <circle cx="42" cy="24" r="6" />
      <path d="M48 24V7" />
      <circle cx="75" cy="31.5" r="6" />
      <path d="M81 31.5V14" />
    </svg>
    <span>Lo spartito apparirà qui.</span>
  </div>`;
}

async function makeDemoFile() {
  const sampleRate = 44100;
  const tempo = Number(tempoInput.value) || 96;
  const secondsPerBeat = 60 / tempo;
  const melody = [64, 66, 67, 69, 71, 72, 71, 69, 67, 66, 64, 64];
  const duration = Math.ceil(melody.length * secondsPerBeat * sampleRate);
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContext({ sampleRate });
  const buffer = context.createBuffer(1, duration, sampleRate);
  const data = buffer.getChannelData(0);
  melody.forEach((midi, index) => {
    const start = Math.floor(index * secondsPerBeat * sampleRate);
    const end = Math.min(data.length, Math.floor((index + 0.85) * secondsPerBeat * sampleRate));
    const freq = midiToFreq(midi);
    for (let i = start; i < end; i += 1) {
      const t = (i - start) / sampleRate;
      const env = Math.min(1, t / 0.04) * Math.min(1, (end - i) / (sampleRate * 0.05));
      data[i] += Math.sin(2 * Math.PI * freq * t) * 0.24 * env;
    }
  });
  await context.close();
  currentFile = new File([encodeWav(buffer)], "melodia-esempio.wav", { type: "audio/wav" });
  await loadAudioFile(currentFile);
}

function encodeWav(buffer) {
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const wav = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(wav);
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i += 1) view.setUint8(offset + i, string.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return wav;
}

audioInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadAudioFile(file);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const file = event.dataTransfer.files?.[0];
  if (file) loadAudioFile(file);
});

analyzeButton.addEventListener("click", runAnalysis);
resetButton.addEventListener("click", resetApp);
demoButton.addEventListener("click", makeDemoFile);
playMelodyButton.addEventListener("click", playMelody);
downloadXmlButton.addEventListener("click", () => downloadText("voce-principale.musicxml", currentXml, "application/vnd.recordare.musicxml+xml"));
downloadSvgButton.addEventListener("click", () => downloadText("voce-principale.svg", currentSvg, "image/svg+xml"));
