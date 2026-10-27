# References

What this project actually builds on. Two lists: **prior art we knowingly follow**, and **techniques we
re-implemented from first principles** (no code copied — see [CREDITS.md](../CREDITS.md)).

If a link rots, search the title; every entry here was checked against the source when written.

---

## 1. Shot boundary detection

**R. Lienhart, "Reliable Transition Detection in Videos: A Survey and Practitioner's Guide",
International Journal of Image and Graphics, 1(3), 2001.**
The canonical survey of cut/gradual-transition detection. Read this before inventing a scorer — most
"new" ideas (histogram distance, edge change ratio, twin comparison) are in it.

**T. Souček, J. Lokoč, "TransNet V2: An effective deep network architecture for fast shot transition
detection", arXiv:2008.04838, 2020.** <https://arxiv.org/abs/2008.04838>
State-of-the-art neural detector (F1 96.2 on BBC Planet Earth). We do **not** ship it — it needs a
TensorFlow/PyTorch runtime and weights, which is exactly the weight we refuse to add. It is listed here
as the accuracy ceiling: if you need gradual transitions (dissolves, wipes), use this instead of us.

**PySceneDetect — `ContentDetector`** (BSD-3-Clause) <https://www.scenedetect.com/>
Where the *idea* of weighting hue/saturation/value deltas separately comes from. Our `scan.js` is an
independent implementation (64×36 HSV, three-channel mean, no adaptive per-channel thresholding).

**FFmpeg `scdet` filter** <https://ffmpeg.org/ffmpeg-filters.html#scdet>
The baseline we benchmark against in the README: 4/9 hard cuts on our fixture versus our 9/9. `scdet`
scores mean absolute frame difference, so a cut that swaps hue at equal luma is invisible to it.

---

## 2. Non-uniform sampling (why "one cut per 1.5 s" is not a hack)

**B. Korbar, D. Tran, L. Torresani, "SCSampler: Sampling Salient Clips from Video for Efficient Action
Recognition", ICCV 2019, arXiv:1904.04289.** <https://arxiv.org/abs/1904.04289>
The formal statement of what this project does at a much smaller scale: pick **K** clips by a cheap
saliency score instead of sampling uniformly, and both accuracy and cost improve (they report +7 % and
>15× less compute on Sports1M). Our density curve is a hand-built saliency score over cut rate; theirs is
learned. We cite it because it makes the same argument — **uniform sampling is not neutral, it is a
choice that discards the parts of the video that change**.

**Inverse-CDF sampling.** Placing cell boundaries at equal increments of a density integral is inverse
transform sampling applied to the time axis. Nothing novel is claimed here.

---

## 3. Frame selection inside a segment

**J. L. Pech-Pacheco, G. Cristóbal, J. Chamorro-Martínez, J. Fernández-Valdivia, "Diatom autofocusing in
brightfield microscopy: a comparative study", ICPR 2000.**
The origin of **variance of the Laplacian** as a focus measure — the metric behind `--pick sharp`.
It is a 25-year-old, 10-line metric that beats `ffmpeg`'s `thumbnail` filter on the one case that matters
here: a segment that fades from blurry to sharp (a histogram is blind to blur).

---

## 4. Loudness

**ITU-R BS.1770-4**, "Algorithms to measure audio programme loudness and true-peak audio level".
**EBU Tech 3341**, "Loudness Metering: 'EBU Mode' metering to supplement EBU R 128".
Implemented by FFmpeg's `ebur128` and `silencedetect` filters, which we call as external processes.

---

## 5. Speech recognition

**FunAudioLLM team, "FunAudioLLM: Voice Understanding and Generation Foundation Models for Natural
Interaction Between Humans and LLMs", arXiv:2407.04051, 2024.** <https://arxiv.org/abs/2407.04051>
Covers SenseVoice (ASR + language ID + speech emotion + audio event detection) and CosyVoice.
SenseVoice-Small is the default endpoint model this tool points at; it is non-autoregressive and reports
~70 ms for 10 s of audio. **Timestamp support landed in 2024-11 via CTC alignment** — earlier builds
returned one text blob with no timings, which is why this project also accepts a plain subtitle track
and chunks requests itself.

**OpenAI `/audio/transcriptions` (verbose_json)** — the wire format we speak, so any
OpenAI-compatible server (FunASR wrappers, whisper-server, speaches, SiliconFlow) works unchanged.
See [asr-contract.md](./asr-contract.md).

---

## 6. Deliberately not used

| Technique | Why not **in-tree** |
|---|---|
| TransNet V2 / deep SBD | weights stay out of the npm package; optional via `extras/dsh-video-enrichment` + `~/.dsh/video.json` |
| Music/emotion models (MERT, CLAP, Qwen-Audio) | same — sidecar / SenseVoice tags; loudness remains the zero-dep measurement |
| Speaker diarization (pyannote) | optional sidecar backend (`DSH_ENRICH_DIARIZE_BACKEND=pyannote`) |
| Learned saliency (SCSampler-style) | a 20-line cut-rate curve gets most of the benefit at zero model cost |
| Optical-flow-based cut detection | 10–50× the compute for a marginal gain over HSV difference |

See [enrichment-contract.md](./enrichment-contract.md) for the HTTP dialect DeepSeek Harness expects.
