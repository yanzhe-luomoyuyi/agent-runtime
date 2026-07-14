/**
 * OpenTelemetry export — bridge the runtime's derived `Trace` (spans + totals,
 * itself derived from the append-only event log, see trace.ts) into real OTel
 * spans that any standard backend (Jaeger, Honeycomb, Datadog, Grafana Tempo,
 * ...) can ingest.
 *
 * This lives in the RUNTIME, not the harness. OTel export does real network
 * IO (shipping spans to a collector), and the harness is deliberately
 * host-agnostic — it only produces structured trace data
 * (`@agent/harness`'s `tracing/collector.ts`) without touching the network.
 * Exporting that data anywhere is a host concern, same as `trace.ts` itself.
 *
 * Design:
 *  - `initOtel()` sets up a `NodeTracerProvider`. When a collector endpoint is
 *    configured (`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 *    read automatically by `OTLPTraceExporter`), spans are shipped there over
 *    OTLP/HTTP. With no endpoint configured, spans are printed via
 *    `ConsoleSpanExporter` instead — so the feature always works offline,
 *    matching the rest of this project's "no required external service" design.
 *  - `exportTrace()` walks `Trace.spans` (flat, pre-sorted by start time then
 *    depth — see `buildTrace`) and recreates the run/phase/step/tool/model
 *    nesting as real parent/child OTel spans. Every span is given an EXPLICIT
 *    start/end time anchored on `Trace.startedAtMs`, so a historical (or
 *    replayed) run exports a historically accurate trace rather than a
 *    synthetic "now" trace.
 *  - `shutdownOtel()` flushes buffered spans before the CLI process exits —
 *    required because `BatchSpanProcessor` batches asynchronously and this is
 *    a short-lived CLI process, not a long-running server.
 */

import {
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  ROOT_CONTEXT,
  trace as otelTrace,
  type Context,
  type Span as OtelSpan,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, ConsoleSpanExporter, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { Span as AgentSpan, Trace } from './trace.js';

export interface OtelOptions {
  /** Resource `service.name`. Default `durable-agent-runtime`. */
  serviceName?: string;
  /**
   * OTLP/HTTP collector endpoint. Default: read from the standard
   * `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` env
   * vars (handled by `OTLPTraceExporter` itself). When neither is set, spans
   * are printed to stdout via `ConsoleSpanExporter` instead of shipped anywhere.
   */
  endpoint?: string;
}

let provider: NodeTracerProvider | undefined;
let tracer: Tracer | undefined;

/** Idempotent: safe to call more than once (returns the existing provider). */
export function initOtel(opts: OtelOptions = {}): NodeTracerProvider {
  if (provider) return provider;

  const hasCollector = Boolean(opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const exporter = hasCollector ? new OTLPTraceExporter(opts.endpoint ? { url: opts.endpoint } : {}) : new ConsoleSpanExporter();

  provider = new NodeTracerProvider({
    resource: new Resource({ [ATTR_SERVICE_NAME]: opts.serviceName ?? 'durable-agent-runtime' }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  tracer = provider.getTracer('durable-agent-runtime');
  return provider;
}

/** Flush any buffered spans and shut the provider down. Call before process exit. */
export async function shutdownOtel(): Promise<void> {
  if (!provider) return;
  await provider.shutdown();
  provider = undefined;
  tracer = undefined;
}

/**
 * Convert a `Trace` into real OTel spans and hand them to the configured
 * exporter. Requires `initOtel()` to have been called first.
 *
 * Nesting is rebuilt from `Span.depth` using a stack: `Trace.spans` is
 * pre-sorted by (startMs, depth), so a parent (lower depth) always precedes
 * its children in the array — the same invariant `renderTimeline` relies on
 * for indentation.
 */
export function exportTrace(trace: Trace): void {
  if (!tracer) throw new Error('initOtel() must be called before exportTrace()');
  const t = tracer;

  const stack: Array<{ depth: number; span: OtelSpan }> = [];
  for (const s of trace.spans) {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= s.depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]!.span : undefined;
    const parentContext: Context = parent ? otelTrace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;

    const startTime = trace.startedAtMs + s.startMs;
    const endTime = startTime + s.durationMs;
    const span = t.startSpan(s.name, { kind: OtelSpanKind.INTERNAL, startTime, attributes: spanAttributes(s, trace) }, parentContext);
    if (s.error) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(endTime);

    stack.push({ depth: s.depth, span });
  }
}

/** Attributes for one span: run-level totals on the root span, per-span data (tool/model) elsewhere. */
function spanAttributes(s: AgentSpan, trace: Trace): Record<string, string | number | boolean> {
  if (s.kind === 'run') {
    const t = trace.totals;
    return {
      'agent.run_id': trace.runId,
      'agent.cost_usd': t.costUsd,
      'agent.cost_saved_usd': t.costSavedUsd,
      'gen_ai.usage.prompt_tokens': t.promptTokens,
      'gen_ai.usage.completion_tokens': t.completionTokens,
      'agent.model_calls': t.modelCalls,
      'agent.tool_calls': t.toolCalls,
      'agent.failed_tool_calls': t.failedToolCalls,
      'agent.policy_denials': t.policyDenials,
      'agent.replay_hit_rate': t.replayHitRate,
      'agent.cached_model_calls': t.cachedModelCalls,
    };
  }
  return { 'agent.span.kind': s.kind, ...s.attributes };
}
