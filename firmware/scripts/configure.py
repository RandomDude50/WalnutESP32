# Script SCons per PlatformIO: configura dinamicamente i parametri del firmware
# senza memorizzare alcun file secrets.h in chiaro.
import os
import sys
import json
import urllib.request
import urllib.error

Import("env")

def escape_c(s):
    if s is None:
        return ""
    return str(s).replace('\\', '\\\\').replace('"', '\\"')

def read_env_file(filepath):
    vals = {}
    if not os.path.isfile(filepath):
        return vals
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip("'\"")
    except Exception:
        pass
    return vals

def fetch_from_webapp(url, token):
    target_url = f"{url.rstrip('/')}/api/device-config?token={token}"
    req = urllib.request.Request(target_url, headers={"User-Agent": "PlatformIO-Flash/1.0"})
    with urllib.request.urlopen(req, timeout=3) as resp:
        if resp.status == 200:
            return json.loads(resp.read().decode("utf-8"))
    return None

def apply_defines(env, params):
    defines = [
        ("WIFI_SSID", f'\\"{escape_c(params.get("wifi_ssid", ""))}\\"'),
        ("WIFI_PASS", f'\\"{escape_c(params.get("wifi_pass", ""))}\\"'),
        ("MQTT_HOST", f'\\"{escape_c(params.get("mqtt_host", "127.0.0.1"))}\\"'),
        ("MQTT_PORT", str(params.get("mqtt_port", 1883))),
        ("MQTT_USER", f'\\"{escape_c(params.get("mqtt_user", ""))}\\"'),
        ("MQTT_PASS", f'\\"{escape_c(params.get("mqtt_pass", ""))}\\"'),
        ("MQTT_USE_TLS", "1" if params.get("mqtt_tls") else "0"),
        ("FW_VERSION", f'\\"{escape_c(params.get("fw_version", "usb"))}\\"'),
    ]
    env.Append(CPPDEFINES=defines)

def main():
    # 1. Caso OTA o parametri passati dal backend (compiler.js)
    if "IOT_JOB_ID" in os.environ or "IOT_WIFI_SSID" in os.environ:
        params = {
            "wifi_ssid": os.environ.get("IOT_WIFI_SSID", ""),
            "wifi_pass": os.environ.get("IOT_WIFI_PASS", ""),
            "mqtt_host": os.environ.get("IOT_MQTT_HOST", "127.0.0.1"),
            "mqtt_port": int(os.environ.get("IOT_MQTT_PORT", "1883")),
            "mqtt_user": os.environ.get("IOT_MQTT_USER", ""),
            "mqtt_pass": os.environ.get("IOT_MQTT_PASS", ""),
            "mqtt_tls": os.environ.get("IOT_MQTT_TLS", "0") == "1",
            "fw_version": os.environ.get("IOT_JOB_ID", "ota"),
        }
        apply_defines(env, params)
        return

    # 2. Controlla se si tratta di un'operazione di flash / upload
    cmd_targets = [str(t) for t in COMMAND_LINE_TARGETS]
    is_upload = any("upload" in t for t in cmd_targets)

    # Se non è un'operazione di upload/flash (es. solo compilazione o cache build), usa default
    if not is_upload:
        params = {
            "wifi_ssid": "warmup",
            "wifi_pass": "",
            "mqtt_host": "127.0.0.1",
            "mqtt_port": 1883,
            "mqtt_user": "",
            "mqtt_pass": "",
            "mqtt_tls": False,
            "fw_version": "dev",
        }
        apply_defines(env, params)
        return

    is_interactive = bool(sys.stdin and sys.stdin.isatty())

    # 3. Flash su ESP32: recupero parametri da Web App + richiesta dati all'utente
    print("\n" + "=" * 64)
    print("  ESP32 Flash - Configurazione parametri (senza secrets.h)")
    print("=" * 64)

    # Radice del progetto (un livello sopra la cartella firmware)
    project_dir = env.subst("$PROJECT_DIR") if hasattr(env, "subst") else os.path.abspath(".")
    root_dir = os.path.abspath(os.path.join(project_dir, ".."))

    env_local = read_env_file(os.path.join(root_dir, ".env.local")) or read_env_file(os.path.join(project_dir, ".env.local"))
    env_prod = read_env_file(os.path.join(root_dir, ".env")) or read_env_file(os.path.join(project_dir, ".env"))
    merged_env = {**env_prod, **env_local}

    default_web_url = merged_env.get("PUBLIC_URL") or os.environ.get("PUBLIC_URL") or "http://localhost:3000"
    default_token = merged_env.get("API_TOKEN") or os.environ.get("API_TOKEN") or "local"

    backend_data = None
    current_url = default_web_url
    current_token = default_token

    # Tenta connessione alla web app
    try:
        backend_data = fetch_from_webapp(current_url, current_token)
    except Exception:
        pass

    if not backend_data and current_url != "http://localhost:3000":
        try:
            backend_data = fetch_from_webapp("http://localhost:3000", current_token)
            if backend_data:
                current_url = "http://localhost:3000"
        except Exception:
            pass

    if not backend_data and is_interactive:
        print(f"[!] Impossibile raggiungere la web app su {current_url}")
        print("    Assicurati che la web app sia avviata (es. 'npm run local').")
        try:
            user_url = input(f"    Inserisci URL della web app [{current_url}] (premi Invio per confermare): ").strip()
            if user_url:
                if not (user_url.startswith("http://") or user_url.startswith("https://")):
                    user_url = "http://" + user_url
                current_url = user_url
                backend_data = fetch_from_webapp(current_url, current_token)
        except (KeyboardInterrupt, EOFError):
            print("\n[!] Operazione annullata.")
            sys.exit(1)
        except Exception as e:
            print(f"    [!] Connessione fallita ({e}).")

    if backend_data:
        print(f"\n[OK] Parametri recuperati automaticamente dalla Web App ({current_url}):")
        mqtt_host = backend_data.get("mqttHost", "127.0.0.1")
        mqtt_port = int(backend_data.get("mqttPort", 1883))
        mqtt_user = backend_data.get("mqttUser", "")
        mqtt_pass = backend_data.get("mqttPass", "")
        mqtt_tls = bool(backend_data.get("mqttTls", False))
        suggested_ssid = backend_data.get("wifiSsid", "")
        print(f"     - Broker MQTT : {mqtt_host}:{mqtt_port} (TLS: {'si' if mqtt_tls else 'no'})")
        if mqtt_user:
            print(f"     - Utente MQTT : {mqtt_user}")
    try:
        if not backend_data:
            print("\n[!] Web app non disponibile: inserisci i parametri del broker manualmente:")
            mqtt_host = input("    Host Broker MQTT [127.0.0.1]: ").strip() or "127.0.0.1"
            mqtt_port_str = input("    Porta Broker MQTT [1883]: ").strip() or "1883"
            mqtt_port = int(mqtt_port_str)
            mqtt_user = input("    Utente MQTT (lascia vuoto se anonimo): ").strip()
            mqtt_pass = input("    Password MQTT: ").strip() if mqtt_user else ""
            mqtt_tls = False
            suggested_ssid = ""

        # Richiesta credenziali Wi-Fi
        print("\nInserisci le credenziali Wi-Fi per l'ESP32 (gli altri parametri del broker sono già stati presi dalla Web App):")
        ssid_prompt = f"  [1/2] SSID Wi-Fi (2.4 GHz) [{suggested_ssid}]: " if suggested_ssid else "  [1/2] SSID Wi-Fi (2.4 GHz): "
        wifi_ssid = ""
        while not wifi_ssid:
            wifi_ssid = input(ssid_prompt).strip()
            if not wifi_ssid and suggested_ssid:
                wifi_ssid = suggested_ssid
            if not wifi_ssid:
                print("  [!] SSID obbligatorio.")

        suggested_pass = merged_env.get("WIFI_PASS") or ""
        if suggested_pass:
            pass_prompt = f"  [2/2] Password Wi-Fi [premi Invio per confermare la password esistente]: "
        else:
            pass_prompt = "  [2/2] Password Wi-Fi (premi Invio per rete aperta): "

        wifi_pass_in = input(pass_prompt).strip()
        wifi_pass = wifi_pass_in if wifi_pass_in else suggested_pass
    except (KeyboardInterrupt, EOFError):
        print("\n[!] Operazione annullata.")
        sys.exit(1)

    print(f"\n[+] Configurazione applicata in memoria per il flash:")
    print(f"    Wi-Fi: '{wifi_ssid}', Broker: {mqtt_host}:{mqtt_port}")
    print("    Nessun file secrets.h memorizzato su disco.\n")

    params = {
        "wifi_ssid": wifi_ssid,
        "wifi_pass": wifi_pass,
        "mqtt_host": mqtt_host,
        "mqtt_port": mqtt_port,
        "mqtt_user": mqtt_user,
        "mqtt_pass": mqtt_pass,
        "mqtt_tls": mqtt_tls,
        "fw_version": "usb",
    }

    apply_defines(env, params)

main()
