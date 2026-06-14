class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = Math.max(8000, Math.min(48000, Number(processorOptions.targetSampleRate || 16000)));
    this.sourceSampleRate = sampleRate;
    this.resampleRatio = this.sourceSampleRate / this.targetSampleRate;
    this.nextOutputSourceIndex = 0;
    this.chunkSize = Math.max(512, Math.min(8192, Number(processorOptions.chunkSize || 2048)));
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.levelSum = 0;
    this.levelCount = 0;
    this.levelFrames = 0;
    this.reportedRate = false;
  }

  pushSample(sample) {
    const clipped = Math.max(-1, Math.min(1, sample));
    this.buffer[this.offset] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    this.offset += 1;

    if (this.offset >= this.chunkSize) {
      const pcm = this.buffer;
      this.buffer = new Int16Array(this.chunkSize);
      this.offset = 0;
      this.port.postMessage({ type: 'audio', buffer: pcm.buffer }, [pcm.buffer]);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (output) output.fill(0);
    if (!input || input.length === 0) return true;

    if (!this.reportedRate) {
      this.port.postMessage({
        type: 'capture_info',
        sourceSampleRate: this.sourceSampleRate,
        targetSampleRate: this.targetSampleRate,
        chunkSize: this.chunkSize
      });
      this.reportedRate = true;
    }

    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i];
      this.levelSum += sample * sample;
      this.levelCount += 1;
    }

    while (this.nextOutputSourceIndex < input.length) {
      const index = Math.floor(this.nextOutputSourceIndex);
      this.pushSample(input[index] || 0);
      this.nextOutputSourceIndex += this.resampleRatio;
    }
    this.nextOutputSourceIndex -= input.length;

    this.levelFrames += input.length;
    if (this.levelFrames >= this.sourceSampleRate / 12) {
      const rms = this.levelCount ? Math.sqrt(this.levelSum / this.levelCount) : 0;
      this.port.postMessage({ type: 'level', value: Math.min(100, Math.round(rms * 260)) });
      this.levelSum = 0;
      this.levelCount = 0;
      this.levelFrames = 0;
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
