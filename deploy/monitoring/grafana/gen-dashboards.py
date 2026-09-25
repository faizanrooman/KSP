#!/usr/bin/env python3
"""Generate the provisioned Grafana dashboards (deterministic JSON). Run after changing panels:
   python3 deploy/monitoring/grafana/gen-dashboards.py
"""
import json
import os

DS = {"type": "prometheus", "uid": "ksp-prometheus"}
OUT = os.path.join(os.path.dirname(__file__), "dashboards")


def panel(pid, title, exprs, x, y, w=12, h=8, unit="short", kind="timeseries"):
    return {
        "id": pid, "type": kind, "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": {"unit": unit}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}} if kind == "timeseries" else {"reduceOptions": {"calcs": ["lastNotNull"]}},
        "targets": [{"refId": chr(65 + i), "datasource": DS, "expr": e, "legendFormat": l} for i, (e, l) in enumerate(exprs)],
    }


def dashboard(uid, title, panels):
    return {
        "uid": uid, "title": title, "tags": ["ksp"], "timezone": "browser", "schemaVersion": 39, "version": 1,
        "refresh": "30s", "time": {"from": "now-6h", "to": "now"}, "editable": False, "panels": panels,
    }


api = dashboard("ksp-api", "KSP VMS — API", [
    panel(1, "Instances up", [('sum(up{job="ksp-api"})', "up")], 0, 0, 6, 4, kind="stat"),
    panel(2, "5xx ratio", [("ksp:api_http_5xx_ratio:rate5m", "5xx")], 6, 0, 6, 4, unit="percentunit", kind="stat"),
    panel(3, "Upload throughput", [("sum(rate(ksp_api_upload_bytes_total[5m]))", "bytes/s")], 12, 0, 12, 4, unit="Bps", kind="stat"),
    panel(4, "Requests/s by status", [('sum by (status) (rate(ksp_api_http_request_duration_seconds_count[5m]))', "{{status}}")], 0, 4),
    panel(5, "Latency p50/p95/p99", [
        ('histogram_quantile(0.5, sum by (le) (rate(ksp_api_http_request_duration_seconds_bucket[5m])))', "p50"),
        ('histogram_quantile(0.95, sum by (le) (rate(ksp_api_http_request_duration_seconds_bucket[5m])))', "p95"),
        ('histogram_quantile(0.99, sum by (le) (rate(ksp_api_http_request_duration_seconds_bucket[5m])))', "p99"),
    ], 12, 4, unit="s"),
    panel(6, "Slowest routes (p95)", [('topk(10, histogram_quantile(0.95, sum by (le, route) (rate(ksp_api_http_request_duration_seconds_bucket[15m]))))', "{{route}}")], 0, 12, unit="s"),
    panel(7, "Auth failures/min by reason", [('sum by (reason) (rate(ksp_api_auth_failures_total[5m])) * 60', "{{reason}}")], 12, 12),
    panel(8, "Resident memory", [("ksp_api_process_resident_memory_bytes", "{{instance}}")], 0, 20, unit="bytes"),
    panel(9, "Event loop lag p99", [("ksp_api_nodejs_eventloop_lag_p99_seconds", "{{instance}}")], 12, 20, unit="s"),
])

worker = dashboard("ksp-worker", "KSP VMS — Worker", [
    panel(1, "Workers up", [('sum(up{job="ksp-worker"})', "up")], 0, 0, 6, 4, kind="stat"),
    panel(2, "CPU", [("rate(ksp_worker_process_cpu_seconds_total[5m])", "{{instance}}")], 6, 0, 18, 8, unit="percentunit"),
    panel(3, "Resident memory", [("ksp_worker_process_resident_memory_bytes", "{{instance}}")], 0, 8, unit="bytes"),
    panel(4, "Event loop lag p99", [("ksp_worker_nodejs_eventloop_lag_p99_seconds", "{{instance}}")], 12, 8, unit="s"),
    panel(5, "Active handles", [("ksp_worker_nodejs_active_handles_total", "{{instance}}")], 0, 16),
    panel(6, "Heap used", [("ksp_worker_nodejs_heap_size_used_bytes", "{{instance}}")], 12, 16, unit="bytes"),
])

os.makedirs(OUT, exist_ok=True)
for d in (api, worker):
    with open(os.path.join(OUT, f"{d['uid']}.json"), "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
print("dashboards written to", OUT)
