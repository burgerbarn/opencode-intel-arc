# Self-contained OpenCode on an Intel Arc laptop

[OpenCode](https://opencode.ai) running entirely on one laptop: the model, the agent, a headless browser and your
rules. No cloud model, no second machine. Built and measured on a Dell XPS 14 (2026) with an Intel Arc B390
integrated GPU on Fedora 44.

What runs on the laptop:

- **Model**: Qwen 3.8 27B (Q4_K_M GGUF) served by `llama-server` from llama.cpp's Vulkan backend, on
  `127.0.0.1:1234`, with flash attention off and MTP speculative decoding on (about 2x faster in OpenCode than
  the defaults, see below). The Arc's matrix units are used (`matrix cores: KHR_coopmat`).
- **OpenCode** web UI in a rootless Podman container (Quadlet), on port 4096, behind a password.
- **Browser control**: Microsoft's Playwright MCP container, headless Chromium, `127.0.0.1:8931` only.
- **Web search**: `mcp-searxng`, pointed at a SearXNG instance you run (optional; the only part that needs the
  internet).
- Shell tools inside the OpenCode container: git, bash, node, npm, python3, pip, curl, ssh.
- Optional ssh access to your other machines with a dedicated key; OpenCode asks before every ssh/scp/rsync/sftp.
- Optional GitHub CLI (`gh`): read commands run freely, anything that writes (and every `git push`) asks first.
- Optional "coach" agent that explains each step before doing it; switch to it in the agent picker.

Two modes, one model loaded at a time: **smart** (Qwen 3.8 27B, default) and **fast** (Qwen 3.6 35B-A3B, about 2x
faster, weaker on hard tasks; see "Choosing smart or fast" below). Nothing starts at boot: `scripts/opencode-ctl
start [smart|fast]|stop|status` (or the desktop launchers "OpenCode (smart)" / "OpenCode (fast)") brings the model, the
browser and the web UI up or down together, so the 17 GB model only uses memory while you use it. Normal suspend
is left alone.

## Hardware and software tested

| | |
|---|---|
| Laptop | Dell XPS 14 (2026), model DA14260 |
| CPU / GPU | Intel Core Ultra X7 358H / Intel Arc B390 (Panther Lake, Xe3) |
| Memory | 32 GB LPDDR5X-9600, 153.6 GB/s (`dmidecode`; 30 GiB usable); Vulkan reports a 23.18 GiB device-local heap |
| OS | Fedora 44 KDE, kernel 7.2.12 (tuning: 7.2.15), Mesa 26.2.5 (tuning: 26.2.6) (ANV), Podman 5.8.9 |
| llama.cpp | release b11969, Vulkan backend |
| OpenCode | 1.19.4 (`ghcr.io/anomalyco/opencode`) |
| Playwright MCP | v0.0.83 (`mcr.microsoft.com/playwright/mcp`) |
| mcp-searxng | 2.9.0 |
| Model | [lmstudio-community/Qwen3.8-27B-GGUF](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF), `Qwen3.8-27B-Q4_K_M.gguf`, sha256 `e00082f779fa385cee8c68a3ec8833a75778cc87272240b942f74e0b8243e520` |

The same CPU/GPU is in the Framework Laptop 13 Pro (Intel), so these numbers should carry over; not tested there.

## Measured performance

### Tuned settings (the ones in this repo)

Two `llama-server` flags roughly halve OpenCode's wall time on this GPU:

1. **Flash attention off** (`-fa off`). On the Arc B390 with Mesa's Vulkan driver, flash attention is fine on an
   empty context but collapses as the conversation grows, and OpenCode always works deep in a long conversation:

   | `llama-bench`, b11969, ubatch 512 | flash attention on | flash attention off |
   |---|---|---|
   | prompt processing at 14.5k tokens depth (pp512 @ d14500) | 55 t/s | **192 t/s** |
   | generation at 14.5k depth (tg32 @ d14500) | 5.14 t/s | 5.55 t/s |

   GPU averaged 1765 MHz, max 70 °C during these runs, so this is not thermal.

2. **MTP speculative decoding** (`--spec-type draft-mtp`). The Qwen 3.8 GGUF carries its own multi-token-prediction
   layer (`blk.64.nextn.*`; without the flag llama.cpp logs it as an unused tensor). A 400-token code answer went
   from 5.38 to **13.0 t/s** with 90% of drafted tokens accepted, and the output was byte-identical at
   temperature 0. Inside OpenCode, where the text is less predictable than code, generation runs 8-9 t/s.

Flash attention off needs a larger compute buffer: at 64k context, ubatch 512 and 256 fail to allocate on the
23 GiB Vulkan heap. 48k context with `-ub 256 --spec-draft-n-ubatch 64` fits: 5.9 GB RAM available with the
whole stack just started, 3.3 GB after the two test runs below. The first ~14.6k-token OpenCode prompt (system prompt + tool definitions) now takes 102 s
at 143 t/s; later chats reuse it from the prompt cache.

Generation without MTP is bound by memory bandwidth: 6.67 t/s x 16.8 GB of weights = ~112 GB/s, ~73% of the
153.6 GB/s this LPDDR5X-9600 provides. MTP gets past that limit because each pass over the weights yields ~3.7
tokens.

OpenCode wall time, same two prompts via `opencode run` (fib: write and run a Python script; search + browser:
SearXNG search plus Playwright on kernel.org), all answers correct:

| Model and settings | fib | search + browser |
|---|---|---|
| Qwen 3.8 27B Q4_K_M, flash attention on (previous version of this repo) | 342 s | 215 s |
| **Qwen 3.8 27B Q4_K_M, `-fa off`, MTP, 48k (this repo)** | **180 s** | **108 s** |
| Qwen3.6-35B-A3B UD-IQ4_XS (MoE), `-fa off`, 64k | 103 s | 90 s |
| gpt-oss-20b MXFP4 (MoE), `-fa off`, 64k | 78 s | 319 s\* |

\* gpt-oss-20b never called the search tool; it read kernel.org ten times through `searxng_web_url_read`
instead. Qwen3.6 counted the sequence from 1 (15th = 610), the others from 0 (377); the prompt allows both.

Mixture-of-experts models on the same benchmark (`llama-bench` b11969, ubatch 512, 14.5k depth):

| Model | size | prompt, FA off / on | generation, FA off / on |
|---|---|---|---|
| Qwen 3.8 27B Q4_K_M (dense) | 15.65 GiB | 192 / 55 t/s | 5.55 / 5.14 t/s (13 with MTP) |
| [Qwen3.6-35B-A3B UD-IQ4_XS](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | 16.50 GiB | 454 / 154 t/s | 25.6 / 26.0 t/s |
| [gpt-oss-20b MXFP4](https://huggingface.co/lmstudio-community/gpt-oss-20b-GGUF) | 11.27 GiB | 281 / 184 t/s | 27.4 / 21.6 t/s |

The MoE models are 3-5x faster per token; the dense 27B is kept as the default here. To run Qwen3.6-35B-A3B
instead, the tested `ExecStart` arguments were
`-m Qwen3.6-35B-A3B-UD-IQ4_XS.gguf --alias qwen/qwen3.8-27b -ngl 99 -c 65536 -ub 512 -fa off --parallel 1 --jinja`
(7.2 GB RAM available right after loading, with the stack running).

### Choosing smart or fast

Measured on the same laptop, 2026-11-07:

| | smart: Qwen 3.8 27B | fast: Qwen 3.6 35B-A3B |
|---|---|---|
| fib / search + browser (`opencode run`) | 180 / 108 s | 103 / 90 s |
| Bug-fix task: 6 planted bugs in 3 files, fix until `unittest` passes, tests untouched | all 6 fixed, 484 s | all 6 fixed, 274 s |
| 10 organic-chemistry tutoring questions with an answer key | 10/10 | 10/10 |
| Qwen's model cards: SWE-bench Pro / HLE / LiveCodeBench v6 | 61.7 / 30.8 / 90.3 | 49.5 / 21.4 / 80.4 |

A 27-task eval with `opencode run`, graded by script, one run per configuration (20 general tasks: Python, shell,
diagnosis, web lookup, chemistry, GitHub; 7 past robotics bugs):

| Round (settings) | Set | smart | fast |
|---|---|---|---|
| 1: xhigh reasoning on smart | 20 general | 17.57 in 209 min | 17.00 in 47 min |
| | 7 robot bugs | 0.00 in 140 min | 5.67 in 26 min |
| 2: medium reasoning, page-read cap, AGENTS.md rules | 20 general | 15.00 in 205 min | 17.23 in 54 min |
| | 7 robot bugs | 5.60 in 79 min | 6.20 in 30 min |
| 3: + thinking cap, continue after denied calls | 20 general | 19.40 in 140 min | 19.56 in 80 min |
| | 7 robot bugs | 5.93 in 67 min | 6.13 in 28 min |

Fast is the default: at round 3 settings it matched or beat smart on both sets in about half the time. The 0.16 and
0.20 gaps are within what one run can show, so this says "no measurable accuracy loss", not "fast is better".
Qwen's model cards still rate smart higher, so use it when fast gets stuck on something hard.

Limits of these numbers: smart's timeouts in rounds 1 and 2 are inflated by an eval bug (leftover runs, see gotchas),
so xhigh and medium were never compared cleanly. The robotics tasks hand the model the evidence up front; collecting
it from a live system is untested. Both models missed the same root cause that Claude Fable and Opus found on one
of those tasks (Fable 6.8/7, Opus 7/7 on the same set). In an earlier bug-fix test, fast's end-of-task summary twice
described changes it had not made, so read the diff.

Not tested yet: newer llama.cpp releases, the SYCL and OpenVINO backends (both need Intel's compute runtime /
oneAPI libraries), and MTP on the MoE models.

### Original settings (flash attention on)

All on the hardware above, Qwen 3.8 27B Q4_K_M, all 64 layers on the GPU, flash attention on.

| Test | Prompt processing | Generation |
|---|---|---|
| `llama-bench` pp512 / tg32 | **281 t/s** | **6.67 t/s** |
| `llama-server`, 11,296-token prompt, `--parallel 1`, default ubatch 512 | **109 t/s** | 5.19 t/s |
| same, ubatch 1024 | 102 t/s | 5.20 t/s |
| same, ubatch 2048 | 93 t/s | 5.16 t/s |
| same, `--parallel 4 --kv-unified` | 85 t/s | 5.17 t/s |
| same, plus vision projector (`--mmproj`) | 107 t/s | 5.16 t/s |
| LM Studio headless (llmster), its default load settings, 5,133-token prompt | 34 t/s | 4.47 t/s |

Generation is bound by memory bandwidth (16.5 GB of weights read per token), so ~5-7 t/s is close to what this
memory allows for a dense 27B model without speculative decoding (MTP, above, doubles it).

Prompt processing slows down as the conversation gets longer, and that is what matters for OpenCode, which keeps
adding tool output to a growing conversation:

| Prompt processing on the Arc B390 (`llama-server`) | t/s |
|---|---|
| empty context (`llama-bench` pp512) | 281 |
| fresh 11k-token prompt | 109 |
| fresh 24k-token prompt | 44 |
| 2.4k new tokens on top of a cached 24k conversation | 24 |

Repeating a cached prompt is near-instant (prompt cache works).

LM Studio vs plain `llama-server`: on a fresh long prompt LM Studio's default load settings were ~3x slower (34 vs
92-109 t/s). Inside real OpenCode sessions, where most turns add a few hundred to a few thousand tokens on top of a
long conversation, both measured ~25-35 t/s. This setup uses `llama-server` because it is fewer moving parts and
leaves more RAM free (10.8 GB vs 7.7 GB with the model loaded), not because OpenCode got faster.

### Like-for-like against an M4 Max MacBook Pro

Same GGUF file (sha256 above), same llama.cpp release (b11969; Vulkan on the XPS, Metal on the Mac), same
`llama-server` flags, same OpenCode 1.19.4, same `opencode.json`, same three prompts via `opencode run`. Numbers
are from `llama-server`'s own timing lines across all calls of the three tasks.

| | XPS 14, balanced profile | XPS 14, `throughput-performance` profile | MacBook Pro M4 Max, 36 GB |
|---|---|---|---|
| Generation | 4.4-5.6 t/s | 5.85 t/s | 17-19.5 t/s |
| Prompt processing mid-conversation (calls > 300 new tokens) | 25-49 t/s | 40-110 t/s | 142-163 t/s |
| First long prompt (~14.6k tokens, cold) | 91 t/s | - | 180 t/s |
| Wall time: fib / search / browser | 273 / 999 / 238 s | 295 / 316\* / failed\*\* | 124 / 100 / 60 s |

\* answered Podman 6.1.0; the current stable release was v6.1.4. \*\* the model tried to read Playwright's page
snapshot outside the workspace, which needs approval, and `opencode run` rejects approvals. Wall times depend on the
path the agent takes and vary run to run; the per-call speeds are the comparable numbers.

Where the time goes: in the balanced run about 770 s were prompt processing and 703 s generation, so OpenCode on
this laptop is limited by both. Generation is bound by memory bandwidth (153.6 GB/s for LPDDR5X-9600 on a
128-bit bus vs 546 GB/s on the M4 Max), which no power profile changes. `throughput-performance` holds the GPU near
its 2.5 GHz maximum at 77 °C with the fans at full speed: worth it for long agent runs, loud for everything else.
The Arc setup is best for short, bounded tasks; long multi-step sessions work but are slow.

Memory: with a 64k context the laptop dropped to 212 MB free RAM under load, so the context is 32k. At 32k with
`--parallel 1`, about 10.8 GB stays free with the model loaded.

A mixture-of-experts model would be much faster on this GPU: a community benchmark on the same chip measured
Qwen3.6-35B-A3B at ~633 t/s prompt / ~33 t/s generation
([grigio.org](https://grigio.org/benchmarking-llama-cpp-backends-on-intel-panther-lake-vulkan-vs-sycl-vs-openvino-vs-cpu/)).
Tested here since: see "Tuned settings" above.

## Setup

These steps match what runs on the test laptop; adjust paths if yours differ.

### 1. llama.cpp with Vulkan

Build llama.cpp with the Vulkan backend (see llama.cpp's
[build docs](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md#vulkan)):

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cd ~/llama.cpp && cmake -B build -DGGML_VULKAN=ON && cmake --build build --config Release -j
```

Check that the Arc and its matrix units are found:

```bash
~/llama.cpp/build/bin/llama-bench -m ~/models/Qwen3.8-27B-Q4_K_M.gguf -ngl 99 -fa 1 -p 512 -n 32
```

The output should include `Intel(R) Arc(tm) B390 ... matrix cores: KHR_coopmat`.

### 2. Model

Download `Qwen3.8-27B-Q4_K_M.gguf` (16.8 GB) from
[lmstudio-community/Qwen3.8-27B-GGUF](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF) into `~/models/`
and compare its sha256 with the one above.

### 3. OpenCode stack

```bash
mkdir -p ~/opencode-stack/workspace ~/opencode-stack/config
mkdir -m 777 ~/opencode-stack/playwright-out   # Playwright snapshots, shared by both containers
cp Containerfile ~/opencode-stack/
cp env.example ~/opencode-stack/.env && chmod 600 ~/opencode-stack/.env    # set a real password
cp gitconfig.example ~/opencode-stack/gitconfig                           # your git name/email
cp config/opencode.json.example ~/opencode-stack/config/opencode.json      # set SEARXNG_URL or remove searxng
cp config/AGENTS.md.example ~/opencode-stack/config/AGENTS.md              # your standing rules
podman build -t localhost/opencode-dev:1.19.4 ~/opencode-stack
podman pull mcr.microsoft.com/playwright/mcp:v0.0.83
```

### 4. Services

```bash
mkdir -p ~/.config/containers/systemd ~/.config/systemd/user
cp quadlet/* ~/.config/containers/systemd/
cp systemd/qwen-llama.service systemd/qwen-fast.service ~/.config/systemd/user/   # edit the paths in ExecStart
systemctl --user daemon-reload
install -Dm755 scripts/opencode-ctl ~/.local/bin/opencode-ctl
install -Dm644 -t ~/.local/share/applications desktop/opencode.desktop desktop/opencode-fast.desktop   # set YOU to your user
opencode-ctl start      # last mode used (smart the first time); waits for the model, then opens the web UI
opencode-ctl start fast # switch: stops the other model, points OpenCode's default (and only listed) model at it
                        # --no-open skips the browser; reload an open web UI tab after switching
opencode-ctl stop
```

The services have no `[Install]` section on purpose. If you want them at boot instead, add
`[Install]` / `WantedBy=default.target` to the three units and run `sudo loginctl enable-linger "$USER"`.

### 5. Firewall (Fedora)

Fedora Workstation's default zone allows incoming connections on ports 1025-65535 on every network, which would
expose port 4096 on any Wi-Fi the laptop joins. Allow it only on your home network:

```bash
sudo firewall-cmd --permanent --zone=home --add-port=4096/tcp
sudo nmcli connection modify "<your home Wi-Fi connection>" connection.zone home
sudo firewall-cmd --set-default-zone=public
sudo firewall-cmd --reload
```

Side effect: other apps that relied on the open high-port range stop accepting LAN connections; e.g. add
`--add-service=kdeconnect` to the home zone if you use KDE Connect.

### 6. Use it

Open <http://localhost:4096> (or `http://<laptop-ip>:4096` from your home network). User `opencode`, password
from `.env`. The model loads when `qwen-llama.service` starts (about 20-30 s).

### 7. ssh to your other machines (optional)

Give OpenCode its own key so you can revoke it separately:

```bash
mkdir -m 700 ~/opencode-stack/ssh
ssh-keygen -t ed25519 -N "" -C "opencode@laptop" -f ~/opencode-stack/ssh/id_ed25519
cp ssh-config.example ~/opencode-stack/ssh/config          # one Host block per machine, by IP
ssh-keygen -F <host-ip> >> ~/opencode-stack/ssh/known_hosts  # repeat per host; strict checking is on
chmod 600 ~/opencode-stack/ssh/*
```

Add `~/opencode-stack/ssh/id_ed25519.pub` to `~/.ssh/authorized_keys` on each machine, then restart
`opencode.service` after uncommenting the ssh `Volume=` line in `opencode.container` (it mounts the folder read-only at `/root/.ssh`), and `opencode.json.example` sets bash
permissions so ssh, scp, rsync and sftp always ask for approval in the web UI (in non-interactive `opencode run`
they are rejected).

### 8. GitHub CLI and the coach agent (optional)

The image includes `gh`. To keep a login, uncomment the `gh` `Volume=` line in `opencode.container`, restart
`opencode.service`, then log in once:

```bash
mkdir -p ~/opencode-stack/gh
podman exec -it opencode gh auth login
```

`opencode.json.example` lets read-only `gh` commands run and asks before any other `gh` command and every
`git push`. For the coach agent, copy `config/agents/coach.md.example` to
`~/opencode-stack/config/agents/coach.md`; it appears in the web UI's agent picker next to Build and Plan.

## Notes and gotchas

- **`.local` names**: the Alpine-based OpenCode container cannot resolve mDNS (`*.local`) names; use IPs (and DHCP
  reservations) in the ssh config.

- **Container to host loopback**: on a custom Podman network, `host.containers.internal` resolved to the host's LAN
  address, so it could not reach a server bound to `127.0.0.1`. The OpenCode container therefore uses
  `Network=host` and talks to `127.0.0.1:1234` and `127.0.0.1:8931`; neither is exposed to the LAN.
- **SELinux**: bind mounts need `:Z`.
- **Idle suspend**: KDE suspends on idle even while a long OpenCode task runs over the network (ssh and background
  jobs do not count as activity). Services come back after resume; the interrupted task does not.
- **Remote reboot / inhibit**: `systemctl reboot` and `systemd-inhibit` over ssh are refused by polkit; use sudo or
  `kde-inhibit` with the session bus.
- **Context size**: 48k with flash attention off (above). With flash attention on, 64k context left ~200 MB free RAM
  under load on 32 GB, so the old setting was 32k.
- **Playwright snapshots**: Playwright MCP saves page snapshots to `/tmp/.playwright-mcp` inside its own container
  and hands the model that path. Without the shared `playwright-out` mount the OpenCode container cannot read them
  (this was the "failed" browser run above).
- **Out-of-memory kills, two separate causes**: llama-server's `--cache-ram` (8 GB) and `--ctx-checkpoints` (32)
  defaults grew host RAM until the kernel killed it; capped to 1024 and 4. Second, `Conflicts=` between the two model
  units does not order them, so a smart/fast switch loaded the new model while the old one was still in memory. One
  `After=` line makes the stop finish first in both directions (lowest free memory during a switch: 4.75 GB).
- **Smart can load in a slow state**: with identical flags, some loads process prompts at 48-105 t/s instead of about
  147 at 14.6k tokens, and stay that way until restarted (generation speed is unaffected). Slow loads show a higher GPU
  clock (about 2050 vs 1490 MHz) with less throughput. Cause unknown. Ruled out by measurement: free memory and
  fragmentation at load, PL1 and thermals, CPU thread placement, and a 20 s pause before loading (2 of 5 still slow).
  `opencode-ctl` works around it: after loading smart it times a ~4k-token prompt and reloads if under 135 t/s, up to
  4 loads (adds about 27 s per start; set `PROBE_MIN` for other hardware). 8 of 8 real switches ended on a good load.
- **Rejected tool calls end the run**: OpenCode 1.19.4 stops the agent loop on a denied call unless
  `experimental.continue_loop_on_deny` is true, so an AGENTS.md rule about rejections has no effect without it.
  With it set, the agent tries another approach after a reject in the web UI; the rejected action stays blocked.
- **`systemctl is-active -q a b c` succeeds if any unit is active**: check units one at a time in scripts.
- **`timeout` around `podman exec` kills only the client**: the process inside the container keeps running. In an
  eval with `--parallel 1` that leftover run steals the slot from the next task and timeouts cascade. Kill it inside
  the container as well.
- **KDE System Monitor shows 0% GPU** on the `xe` driver: Fedora ships `/usr/libexec/ksystemstats_xe_helper` without
  the `cap_perfmon` capability its i915 helper gets, so it fails with "Failed opening any event". Fix:
  `sudo setcap cap_perfmon=ep /usr/libexec/ksystemstats_xe_helper && systemctl --user restart plasma-ksystemstats`
  (a ksystemstats update may reset it). llama.cpp's Vulkan backend runs on the compute engine, so tools that only
  graph the render engine also show ~0%; `nvtop` shows it.

## Uninstall

```bash
opencode-ctl stop
systemctl --user stop opencode.service opencode-playwright.service
rm ~/.config/containers/systemd/opencode* ~/.config/systemd/user/qwen-llama.service ~/.config/systemd/user/qwen-fast.service ~/.local/bin/opencode-ctl ~/.local/share/applications/opencode*.desktop
systemctl --user daemon-reload
podman volume rm opencode-data; podman network rm opencode
```

## License

MIT
