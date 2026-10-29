# Self-contained OpenCode on an Intel Arc laptop

[OpenCode](https://opencode.ai) running entirely on one laptop: the model, the agent, a headless browser and your
rules. No cloud model, no second machine. Built and measured on a Dell XPS 14 (2026) with an Intel Arc B390
integrated GPU on Fedora 44.

What runs on the laptop:

- **Model**: Qwen 3.8 27B (Q4_K_M GGUF) served by `llama-server` from llama.cpp's Vulkan backend, on
  `127.0.0.1:1234`. The Arc's matrix units are used (`matrix cores: KHR_coopmat`).
- **OpenCode** web UI in a rootless Podman container (Quadlet), on port 4096, behind a password.
- **Browser control**: Microsoft's Playwright MCP container, headless Chromium, `127.0.0.1:8931` only.
- **Web search**: `mcp-searxng`, pointed at a SearXNG instance you run (optional; the only part that needs the
  internet).
- Shell tools inside the OpenCode container: git, bash, node, npm, python3, pip, curl, ssh.
- Optional ssh access to your other machines with a dedicated key; OpenCode asks before every ssh/scp/rsync/sftp.
- Optional GitHub CLI (`gh`): read commands run freely, anything that writes (and every `git push`) asks first.
- Optional "coach" agent that explains each step before doing it; switch to it in the agent picker.

Nothing starts at boot: `scripts/opencode-ctl start|stop|status` (or the desktop launcher) brings the model, the
browser and the web UI up or down together, so the 17 GB model only uses memory while you use it. Normal suspend
is left alone.

## Hardware and software tested

| | |
|---|---|
| Laptop | Dell XPS 14 (2026), model DA14260 |
| CPU / GPU | Intel Core Ultra X7 358H / Intel Arc B390 (Panther Lake, Xe3) |
| Memory | 32 GB LPDDR5X-7467 (30 GiB usable); Vulkan reports a 23.18 GiB device-local heap |
| OS | Fedora 44 KDE, kernel 7.2.12, Mesa 26.2.5 (ANV), Podman 5.8.9 |
| llama.cpp | release b11969, Vulkan backend |
| OpenCode | 1.19.4 (`ghcr.io/anomalyco/opencode`) |
| Playwright MCP | v0.0.83 (`mcr.microsoft.com/playwright/mcp`) |
| mcp-searxng | 2.9.0 |
| Model | [lmstudio-community/Qwen3.8-27B-GGUF](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF), `Qwen3.8-27B-Q4_K_M.gguf`, sha256 `e00082f779fa385cee8c68a3ec8833a75778cc87272240b942f74e0b8243e520` |

The same CPU/GPU is in the Framework Laptop 13 Pro (Intel), so these numbers should carry over; not tested there.

## Measured performance

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
memory allows for a dense 27B model.

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
this laptop is limited by both. Generation is bound by memory bandwidth (about 120 GB/s for LPDDR5X-7467 on a
128-bit bus vs 546 GB/s on the M4 Max), which no power profile changes. `throughput-performance` holds the GPU near
its 2.5 GHz maximum at 77 °C with the fans at full speed: worth it for long agent runs, loud for everything else.
The Arc setup is best for short, bounded tasks; long multi-step sessions work but are slow.

Memory: with a 64k context the laptop dropped to 212 MB free RAM under load, so the context is 32k. At 32k with
`--parallel 1`, about 10.8 GB stays free with the model loaded.

A mixture-of-experts model would be much faster on this GPU: a community benchmark on the same chip measured
Qwen3.6-35B-A3B at ~633 t/s prompt / ~33 t/s generation
([grigio.org](https://grigio.org/benchmarking-llama-cpp-backends-on-intel-panther-lake-vulkan-vs-sycl-vs-openvino-vs-cpu/)).
Not tested here.

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
cp systemd/qwen-llama.service ~/.config/systemd/user/      # edit the two paths in ExecStart
systemctl --user daemon-reload
install -Dm755 scripts/opencode-ctl ~/.local/bin/opencode-ctl
install -Dm644 desktop/opencode.desktop ~/.local/share/applications/opencode.desktop   # set YOU to your user
opencode-ctl start      # waits for the model, then opens the web UI; --no-open to skip the browser
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
- **Context size**: 64k context left ~200 MB free RAM under load on 32 GB; 32k is the setting here.

## Uninstall

```bash
opencode-ctl stop
systemctl --user stop opencode.service opencode-playwright.service
rm ~/.config/containers/systemd/opencode* ~/.config/systemd/user/qwen-llama.service ~/.local/bin/opencode-ctl ~/.local/share/applications/opencode.desktop
systemctl --user daemon-reload
podman volume rm opencode-data; podman network rm opencode
```

## License

MIT
