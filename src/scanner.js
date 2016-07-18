const EventEmitter = require('events');
const ZXing = require('./zxing')();
const Visibility = require('visibilityjs');
const StateMachine = require('fsm-as-promised');

class ActiveScan {
  constructor(emitter, analyzer, captureImage, scanPeriod, refractoryPeriod) {
    this.scanPeriod = scanPeriod;
    this.captureImage = captureImage;
    this.refractoryPeriod = refractoryPeriod;
    this._emitter = emitter;
    this._frameCount = 0;
    this._analyzer = analyzer;
    this._active = false;
  }

  start() {
    this._active = true;
    requestAnimationFrame(() => this._scan());
  }

  stop() {
    this._active = false;
  }

  _scan() {
    if (!this._active) {
      return;
    }

    requestAnimationFrame(() => this._scan());

    if (++this._frameCount !== this.scanPeriod) {
      return;
    } else {
      this._frameCount = 0;
    }

    let analysis = this._analyzer.analyze();
    if (!analysis) {
      return;
    }

    let { result, canvas } = analysis;
    if (!result || result === this.lastResult) {
      return;
    }

    clearTimeout(this.refractoryTimeout);
    this.refractoryTimeout = setTimeout(() => {
      this.lastResult = null;
    }, this.refractoryPeriod);

    let image = this.captureImage ? canvas.toDataURL('image/webp', 0.8) : null;

    this.lastResult = result;
    setTimeout(() => {
      this._emitter.emit('scan', result, image);
    }, 0);
  }
}

class Analyzer {
  constructor(video) {
    this.video = video;

    this.imageBuffer = null;
    this.sensorLeft = null;
    this.sensorTop = null;
    this.sensorWidth = null;
    this.sensorHeight = null;

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'none';
    this.canvasContext = null;

    this.decodeCallback = ZXing.Runtime.addFunction(function (ptr, len, resultIndex, resultCount) {
      var result = new Uint8Array(ZXing.HEAPU8.buffer, ptr, len);
      var str = String.fromCharCode.apply(null, result);
      if (resultIndex === 0) {
        window.zxDecodeResult = '';
      }
      window.zxDecodeResult += str;
    });
  }

  analyze() {
    if (!this.video.videoWidth) {
      return null;
    }

    if (!this.imageBuffer) {
      let videoWidth = this.video.videoWidth;
      let videoHeight = this.video.videoHeight;

      this.sensorWidth = videoWidth;
      this.sensorHeight = videoHeight;
      this.sensorLeft = Math.floor((videoWidth / 2) - (this.sensorWidth / 2));
      this.sensorTop = Math.floor((videoHeight / 2) - (this.sensorHeight / 2));

      this.canvas.width = this.sensorWidth;
      this.canvas.height = this.sensorHeight;

      this.canvasContext = this.canvas.getContext('2d');
      this.imageBuffer = ZXing._resize(this.sensorWidth, this.sensorHeight);
      return null;
    }

    this.canvasContext.drawImage(
      this.video,
      this.sensorLeft,
      this.sensorTop,
      this.sensorWidth,
      this.sensorHeight
    );

    let data = this.canvasContext.getImageData(0, 0, this.sensorWidth, this.sensorHeight).data;
    for (var i = 0, j = 0; i < data.length; i += 4, j++) {
      ZXing.HEAPU8[this.imageBuffer + j] = data[i];
    }

    let err = ZXing._decode_qr(this.decodeCallback);
    if (err) {
      return null;
    }

    let result = window.zxDecodeResult;
    if (result != null) {
      return { result: result, canvas: this.canvas };
    }

    return null;
  }
}

class Scanner extends EventEmitter {
  constructor(opts) {
    super();

    this.video = this._configureVideo(opts);
    this.backgroundScan = opts.backgroundScan || false;
    this._analyzer = new Analyzer(this.video);
    this._camera = null;

    let captureImage = opts.captureImage || false;
    let scanPeriod = opts.scanPeriod || 1;
    let refractoryPeriod = opts.refractoryPeriod || (5 * 1000);

    this._scan = new ActiveScan(this, this._analyzer, captureImage, scanPeriod, refractoryPeriod);

    this._fsm = StateMachine.create({
      initial: 'stopped',
      events: [
        {
          name: 'start',
          from: 'stopped',
          to: 'started'
        },
        {
          name: 'stop',
          from: ['started', 'active', 'inactive'],
          to: 'stopped'
        },
        {
          name: 'activate',
          from: ['started', 'inactive'],
          to: ['active', 'inactive'],
          condition: function (options) {
            if (Visibility.state() === 'visible' || this.backgroundScan) {
              return 'active';
            } else {
              return 'inactive';
            }
          }
        },
        {
          name: 'deactivate',
          from: ['started', 'active'],
          to: 'inactive'
        }
      ],
      callbacks: {
        onenteractive: async (options) => {
          await this._enableScan(options.args[0]);
          this.emit('active');
        },
        onleaveactive: () => {
          this._disableScan();
          this.emit('inactive');
        },
        onenteredstarted: async (options) => {
          await this._fsm.activate(options.args[0]);
        }
      }
    });

    Visibility.change((e, state) => {
      if (state === 'visible') {
        setTimeout(() => {
          if (this._fsm.can('activate')) {
            this._fsm.activate();
          }
        }, 0);
      } else {
        if (!this.backgroundScan && this._fsm.can('deactivate')) {
          this._fsm.deactivate();
        }
      }
    });

    this.emit('inactive');
  }

  async start(camera = null) {
    if (this._fsm.can('start')) {
      await this._fsm.start(camera);
    } else {
      await this._fsm.stop();
      await this._fsm.start(camera);
    }
  }

  async stop() {
    if (this._fsm.can('stop')) {
      await this._fsm.stop();
    }
  }

  set captureImage(capture) {
    this._scan.captureImage = capture;
  }

  get captureImage() {
    return this._scan.captureImage;
  }

  set scanPeriod(period) {
    this._scan.scanPeriod = period;
  }

  get scanPeriod() {
    return this._scan.scanPeriod;
  }

  set refractoryPeriod(period) {
    this._scan.refractoryPeriod = period;
  }

  get refractoryPeriod() {
    return this._scan.refractoryPeriod;
  }

  async _enableScan(camera) {
    this._camera = camera || this._camera;
    if (!this._camera) {
      throw new Error('Camera is not defined.');
    }

    let streamUrl = await this._camera.start();
    this.video.src = streamUrl;
    this._scan.start();
  }

  _disableScan() {
    this.video.src = '';

    if (this._scan) {
      this._scan.stop();
    }

    if (this._camera) {
      this._camera.stop();
    }
  }

  _configureVideo(opts) {
    if (opts.video) {
      if (opts.video.tagName !== 'VIDEO') {
        throw new Error('Video must be a <video> element.');
      }
    }

    var video = opts.video || document.createElement('video');
    video.setAttribute('autoplay', 'autoplay');

    if (opts.mirror !== false && opts.video) {
      video.style.MozTransform = 'scaleX(-1)';
      video.style.webkitTransform = 'scaleX(-1)';
      video.style.OTransform = 'scaleX(-1)';
      video.style.msFilter = 'FlipH';
      video.style.filter = 'FlipH';
      video.style.transform = 'scaleX(-1)';
    }

    return video;
  }
}

module.exports = Scanner;
