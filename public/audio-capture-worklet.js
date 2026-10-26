class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 16000;
    this.ratio = sampleRate / this.targetSampleRate;
    this.chunkSize = options.processorOptions?.chunkSize || 1024;
    this.buffer = new Int16Array(this.chunkSize); this.offset = 0;
    this.sum = 0; this.weight = 0;
    this.port.onmessage = event => {
      if (event.data?.type !== 'flush') return;
      if (this.weight > 0) { this.push(this.sum / this.weight, true); this.sum = 0; this.weight = 0; }
      if (this.offset) {
        const buffer = this.buffer.slice(0, this.offset).buffer;
        this.port.postMessage({ type: 'audio', buffer, flush: true }, [buffer]); this.offset = 0;
      }
      this.port.postMessage({ type: 'flushed' });
    };
  }
  push(value, flush = false) {
    const s = Math.max(-1, Math.min(1, value));
    this.buffer[this.offset++] = s < 0 ? s * 32768 : s * 32767;
    if (this.offset === this.chunkSize) {
      const buffer = this.buffer.buffer;
      this.port.postMessage({ type: 'audio', buffer, flush }, [buffer]);
      this.buffer = new Int16Array(this.chunkSize); this.offset = 0;
    }
  }
  process(inputs, outputs) {
    for (const output of outputs[0] || []) output.fill(0);
    const input = inputs[0]?.[0]; if (!input) return true;
    for (const value of input) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-8) { this.push(this.sum / this.ratio); this.sum = 0; this.weight = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
