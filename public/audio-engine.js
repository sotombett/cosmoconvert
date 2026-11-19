// CosmoConvert — Встроенный браузерный Web Audio DSP + MP3/WAV движок

window.CosmoAudioEngine = {
  _lamePromise: null,

  // Ленивая загрузка MP3-кодека lamejs (используется как резерв, если локально не установлен FFmpeg)
  loadLameJs() {
    if (window.lamejs && window.lamejs.Mp3Encoder) {
      return Promise.resolve(window.lamejs);
    }
    if (this._lamePromise) return this._lamePromise;

    this._lamePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js';
      script.onload = () => {
        if (window.lamejs && window.lamejs.Mp3Encoder) resolve(window.lamejs);
        else reject(new Error('MP3-кодек не инициализировался'));
      };
      script.onerror = () => {
        this._lamePromise = null;
        reject(new Error('Не удалось загрузить браузерный MP3-кодек'));
      };
      document.head.appendChild(script);
    });
    return this._lamePromise;
  },

  // Кодирование AudioBuffer в настоящий MP3 с точным битрейтом (128 / 192 / 320 kbps)
  async encodeMp3(audioBuffer, kbps = 128) {
    const lame = await this.loadLameJs();
    const numChannels = Math.min(2, audioBuffer.numberOfChannels);
    const sampleRate = audioBuffer.sampleRate;
    const targetKbps = [128, 192, 320].includes(Number(kbps)) ? Number(kbps) : 128;
    const mp3encoder = new lame.Mp3Encoder(numChannels, sampleRate, targetKbps);

    const floatToInt16 = (f32) => {
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return out;
    };

    const left = floatToInt16(audioBuffer.getChannelData(0));
    const right = numChannels > 1 ? floatToInt16(audioBuffer.getChannelData(1)) : null;

    const blockSize = 1152;
    const mp3Data = [];

    for (let i = 0; i < left.length; i += blockSize) {
      const leftChunk = left.subarray(i, i + blockSize);
      const mp3buf = numChannels === 2
        ? mp3encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
        : mp3encoder.encodeBuffer(leftChunk);
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }

    const flushBuf = mp3encoder.flush();
    if (flushBuf.length > 0) mp3Data.push(flushBuf);

    return new Blob(mp3Data, { type: 'audio/mpeg' });
  },

  // Кодирование AudioBuffer в стандартный 16-bit PCM WAV Blob
  encodeWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  },

  // Декодирование аудиодорожки из аудио- или видеофайла
  async decodeFile(file) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const arrayBuf = await file.arrayBuffer();
      return await ctx.decodeAudioData(arrayBuf.slice(0));
    } finally {
      if (ctx.state !== 'closed') await ctx.close();
    }
  },

  // Быстрый 3-полосный анализ спектра (Bass / Mid / High)
  analyzeThreeBandWaveform(audioBuffer, numBars = 150) {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const totalLen = ch0.length;
    const sr = audioBuffer.sampleRate;
    const stride = Math.max(1, Math.floor(totalLen / 180000));
    const effSr = sr / stride;

    const alphaLow = 1 - Math.exp((-2 * Math.PI * 280) / effSr);
    const alphaHigh = 1 - Math.exp((-2 * Math.PI * 2800) / effSr);

    const bass = new Float32Array(numBars);
    const mid = new Float32Array(numBars);
    const high = new Float32Array(numBars);

    let lpLow = 0;
    let lpMid = 0;
    let maxVal = 0.001;

    for (let i = 0; i < totalLen; i += stride) {
      const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      lpLow += alphaLow * (s - lpLow);
      lpMid += alphaHigh * (s - lpMid);

      const bVal = Math.abs(lpLow);
      const mVal = Math.abs(lpMid - lpLow);
      const hVal = Math.abs(s - lpMid);

      const bin = Math.min(numBars - 1, Math.floor((i / totalLen) * numBars));
      if (bVal > bass[bin]) bass[bin] = bVal;
      if (mVal > mid[bin]) mid[bin] = mVal;
      if (hVal > high[bin]) high[bin] = hVal;

      const totalPeak = Math.max(bVal, mVal, hVal);
      if (totalPeak > maxVal) maxVal = totalPeak;
    }

    for (let b = 0; b < numBars; b++) {
      bass[b] = Math.min(1, bass[b] / maxVal);
      mid[b] = Math.min(1, (mid[b] * 1.15) / maxVal);
      high[b] = Math.min(1, (high[b] * 1.45) / maxVal);
    }

    return { bass, mid, high };
  },

  // Офлайн-рендеринг AudioBuffer с обрезкой, изменением тональности/скорости и громкости
  async renderEditedAudioBuffer(audioBuffer, { startSec = 0, endSec = null, pitchSemitones = 0, speed = 1.0, volumePercent = 100 } = {}) {
    const duration = audioBuffer.duration;
    const s = Math.max(0, Math.min(duration - 0.05, startSec));
    const e = endSec === null ? duration : Math.max(s + 0.05, Math.min(duration, endSec));
    const sliceLen = e - s;

    const pitchRate = Math.pow(2, pitchSemitones / 12);
    const effectiveRate = Math.max(0.25, Math.min(4.0, speed * pitchRate));
    const outDuration = Math.max(0.05, sliceLen / effectiveRate);
    const targetSampleRate = audioBuffer.sampleRate;
    const outFrames = Math.ceil(outDuration * targetSampleRate);

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(audioBuffer.numberOfChannels, outFrames, targetSampleRate);

    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = effectiveRate;

    const gain = offline.createGain();
    gain.gain.value = Math.max(0, Math.min(3, volumePercent / 100));

    source.connect(gain);
    gain.connect(offline.destination);
    source.start(0, s, sliceLen);

    return await offline.startRendering();
  },

  async renderEditedAudio(audioBuffer, options = {}) {
    const rendered = await this.renderEditedAudioBuffer(audioBuffer, options);
    return this.encodeWav(rendered);
  },

  formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
};
