"""Python 3.9+ — standard library only. Run: python3 docs/quickstarts/python.py"""
import json
import os
import urllib.error
import urllib.request

SUI = os.environ.get("SUI", "http://127.0.0.1:8787")


def chat(prompt: str, model: str = "chat-default") -> dict:
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}]}).encode()
    request = urllib.request.Request(
        f"{SUI}/v1/chat/completions",
        data=body,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        # Errors are already sentences with a next step — print them as they are.
        payload = json.load(err)
        raise SystemExit(payload["error"]["message"]) from None


result = chat("Explain a circuit breaker in one sentence.")
print(result["choices"][0]["message"]["content"])
print("—", result["sui"]["provider"], result["sui"]["modelId"], f'{result["sui"]["latencyMs"]}ms')
