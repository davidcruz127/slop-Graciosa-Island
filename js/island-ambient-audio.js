export function createIslandAmbientAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Este navegador no admite audio ambiental WebAudio.');
  const context = new AudioContext();
  const master = context.createGain();
  const wind = context.createGain();
  const sea = context.createGain();
  const windNoise = context.createBufferSource();
  const seaNoise = context.createBufferSource();
  const buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
  const channel = buffer.getChannelData(0);
  let brown = 0;
  for (let i = 0; i < channel.length; i++) {
    brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    channel[i] = brown * 3.5;
  }
  windNoise.buffer = buffer;
  windNoise.loop = true;
  seaNoise.buffer = buffer;
  seaNoise.loop = true;
  const windFilter = context.createBiquadFilter();
  windFilter.type = 'lowpass';
  windFilter.frequency.value = 620;
  const seaFilter = context.createBiquadFilter();
  seaFilter.type = 'bandpass';
  seaFilter.frequency.value = 950;
  seaFilter.Q.value = 0.45;
  const swell = context.createOscillator();
  const swellGain = context.createGain();
  swell.frequency.value = 0.075;
  swellGain.gain.value = 0.018;
  wind.gain.value = 0.045;
  sea.gain.value = 0.04;
  master.gain.value = 0;
  windNoise.connect(windFilter).connect(wind).connect(master);
  seaNoise.connect(seaFilter).connect(sea).connect(master);
  swell.connect(swellGain).connect(sea.gain);
  master.connect(context.destination);
  windNoise.start();
  seaNoise.start();
  swell.start();
  let disposed = false;

  return {
    async setEnabled(enabled) {
      if (disposed) throw new Error('El audio ambiental ya se ha cerrado.');
      await context.resume();
      master.gain.setTargetAtTime(enabled ? 0.7 : 0, context.currentTime, 0.35);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await context.close();
    }
  };
}
