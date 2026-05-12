// AgentMark Windows UIA Bridge
// ----------------------------
// Stdio JSON-RPC 2.0 server. Parent process (typically the Node-side
// `WindowsUiaBackend` running inside the AgentMark MCP server, or a
// ThinkFleet SaaS agent) launches this exe and talks to it over
// stdin/stdout. One line of JSON per message.
//
// Protocol:
//   Request : { "jsonrpc": "2.0", "id": <any>, "method": "<name>", "params": {...} }
//   Response: { "jsonrpc": "2.0", "id": <same>, "result": {...} }   on success
//             { "jsonrpc": "2.0", "id": <same>, "error": { "code": N, "message": "..." } }  on failure
//
// All diagnostic output goes to stderr — never stdout — so the framing stays clean.
//
// Methods (current set; more land as Phase 0e progresses):
//   ping        — returns { pong: true, version: "...", arch: "arm64|x64" }
//   capabilities— returns { methods: [...], uia_version: "..." }
//
// Phase 0e2/0e3 will add:
//   capture     — walk a window's UIA tree, return DesktopCapture JSON
//   execute     — drive an action by element_id (click/type/select/etc.)
//   list_windows— enumerate top-level windows visible to the bridge

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AgentMark.Bridge.Windows.Uia;

namespace AgentMark.Bridge.Windows;

internal static class Program
{
    // JSON serialization options — camelCase to match the AgentMark
    // wire format on the Node side.
    internal static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static int Main(string[] args)
    {
        // Force UTF-8 on both pipes -- Windows defaults can mangle non-ASCII.
        // Use UTF8Encoding(false) to avoid emitting a BOM on stdout, which
        // would break JSON-RPC framing on the parent side.
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.Error.WriteLine($"[bridge] agentmark-bridge-windows starting (pid={Environment.ProcessId}, arch={System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture})");

        // Synchronous read loop. Async stdin reads on Windows pipes have a
        // known issue where ReadLineAsync() doesn't always return null on
        // EOF, leaving the process hung even after the parent closes the
        // pipe. ReadLine() handles EOF correctly. UIA calls are themselves
        // blocking COM-STA invocations so async doesn't buy us anything.
        using var dispatcher = new RpcDispatcher();

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            // Strip UTF-8 BOM if a client wrote one at the start of the
            // stream. Windows clients (PowerShell especially) do this
            // unpredictably on the first WriteLine, depending on stream
            // buffering. Without this strip the first JSON request gets
            // a leading U+FEFF and JsonDocument.Parse rejects it.
            line = line.Trim().TrimStart('\uFEFF');
            if (line.Length == 0) continue;

            JsonElement reqId = default;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                reqId = root.TryGetProperty("id", out var idEl) ? idEl.Clone() : default;

                var method = root.GetProperty("method").GetString()
                             ?? throw new RpcException(RpcError.InvalidRequest, "method is required");
                var paramsEl = root.TryGetProperty("params", out var p) ? p : default;

                var result = dispatcher.Dispatch(method, paramsEl);
                Console.Out.WriteLine(EncodeSuccess(reqId, result));
            }
            catch (RpcException rex)
            {
                Console.Out.WriteLine(EncodeError(reqId, rex.Error.Code, rex.Message));
            }
            catch (JsonException jex)
            {
                Console.Out.WriteLine(EncodeError(reqId, RpcError.ParseError.Code, $"JSON parse error: {jex.Message}"));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[bridge] unhandled: {ex}");
                Console.Out.WriteLine(EncodeError(reqId, RpcError.InternalError.Code, ex.Message));
            }

            Console.Out.Flush();
        }

        Console.Error.WriteLine("[bridge] stdin closed; exiting");
        return 0;
    }

    private static string EncodeSuccess(JsonElement id, object? result)
    {
        var env = new RpcResponseSuccess
        {
            Id = id.ValueKind == JsonValueKind.Undefined ? null : id,
            Result = result,
        };
        return JsonSerializer.Serialize(env, JsonOpts);
    }

    private static string EncodeError(JsonElement id, int code, string message)
    {
        var env = new RpcResponseError
        {
            Id = id.ValueKind == JsonValueKind.Undefined ? null : id,
            Error = new RpcErrorBody { Code = code, Message = message },
        };
        return JsonSerializer.Serialize(env, JsonOpts);
    }
}

// ──────────────────────────────────────────────────────────────────────
// Wire format
// ──────────────────────────────────────────────────────────────────────

internal sealed class RpcResponseSuccess
{
    [JsonPropertyName("jsonrpc")]
    public string Jsonrpc => "2.0";

    [JsonPropertyName("id")]
    public JsonElement? Id { get; init; }

    [JsonPropertyName("result")]
    public object? Result { get; init; }
}

internal sealed class RpcResponseError
{
    [JsonPropertyName("jsonrpc")]
    public string Jsonrpc => "2.0";

    [JsonPropertyName("id")]
    public JsonElement? Id { get; init; }

    [JsonPropertyName("error")]
    public RpcErrorBody Error { get; init; } = null!;
}

internal sealed class RpcErrorBody
{
    [JsonPropertyName("code")]
    public int Code { get; init; }

    [JsonPropertyName("message")]
    public string Message { get; init; } = "";
}

// ──────────────────────────────────────────────────────────────────────
// Error catalog
// ──────────────────────────────────────────────────────────────────────

internal readonly record struct RpcError(int Code)
{
    public static readonly RpcError ParseError = new(-32700);
    public static readonly RpcError InvalidRequest = new(-32600);
    public static readonly RpcError MethodNotFound = new(-32601);
    public static readonly RpcError InvalidParams = new(-32602);
    public static readonly RpcError InternalError = new(-32603);

    // Bridge-specific (above -32000)
    public static readonly RpcError WindowNotFound = new(-32010);
    public static readonly RpcError ElementNotFound = new(-32011);
    public static readonly RpcError UnsupportedPattern = new(-32012);
    public static readonly RpcError ActionFailed = new(-32013);
}

internal sealed class RpcException(RpcError error, string message) : Exception(message)
{
    public RpcError Error { get; } = error;
}

// ──────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────

internal sealed class RpcDispatcher : IDisposable
{
    private static readonly string BridgeVersion = "0.4.0";

    // UIA work is lazy-initialised — ping/capabilities don't need it and
    // booting UIA on startup adds ~150ms we don't want for clients that
    // only smoke-test the bridge.
    private readonly Lazy<StaWorker> _staWorker = new(() => new StaWorker());
    private readonly Lazy<UiaCapturer> _capturer;

    public RpcDispatcher()
    {
        _capturer = new Lazy<UiaCapturer>(() => _staWorker.Value.Invoke(() => new UiaCapturer()));
    }

    public object? Dispatch(string method, JsonElement @params)
    {
        return method switch
        {
            "ping"          => HandlePing(),
            "capabilities"  => HandleCapabilities(),
            "list_windows"  => HandleListWindows(),
            "capture"       => HandleCapture(@params),
            "execute"       => HandleExecute(@params),
            "execute_batch" => HandleExecuteBatch(@params),
            _ => throw new RpcException(
                RpcError.MethodNotFound,
                $"Unknown method: {method}. Supported: ping, capabilities, list_windows, capture, execute, execute_batch."),
        };
    }

    public void Dispose()
    {
        if (_capturer.IsValueCreated)
        {
            try { _staWorker.Value.Invoke(() => _capturer.Value.Dispose()); } catch { /* swallow */ }
        }
        if (_staWorker.IsValueCreated)
        {
            try { _staWorker.Value.Dispose(); } catch { /* swallow */ }
        }
    }

    private static object HandlePing() => new
    {
        pong = true,
        version = BridgeVersion,
        arch = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
        processId = Environment.ProcessId,
    };

    private static object HandleCapabilities() => new
    {
        bridge = "agentmark-bridge-windows",
        version = BridgeVersion,
        methods = new[]
        {
            "ping",
            "capabilities",
            "list_windows",
            "capture",
            "execute",
            "execute_batch",
        },
        uiaProvider = "FlaUI.UIA3",
        platform = "windows",
    };

    private object HandleListWindows()
    {
        var capturer = _capturer.Value;
        var sta = _staWorker.Value;
        var windows = sta.Invoke(() => capturer.ListWindows());
        return new { windows };
    }

    private object HandleCapture(JsonElement @params)
    {
        var req = new UiaCapturer.CaptureRequest
        {
            ProcessName = ReadString(@params, "processName"),
            ProcessId = ReadInt(@params, "processId"),
            WindowTitle = ReadString(@params, "windowTitle"),
            WindowId = ReadString(@params, "windowId"),
            MaxDepth = ReadInt(@params, "maxDepth") ?? 12,
            IncludeHidden = ReadBool(@params, "includeHidden") ?? false,
            TimeoutMs = ReadInt(@params, "timeoutMs") ?? 5000,
            MaxElements = ReadInt(@params, "maxElements") ?? 2000,
        };

        try
        {
            var capturer = _capturer.Value;
            var sta = _staWorker.Value;
            return sta.Invoke(() => capturer.Capture(req));
        }
        catch (InvalidOperationException ex)
        {
            throw new RpcException(RpcError.WindowNotFound, ex.Message);
        }
    }

    private object HandleExecute(JsonElement @params)
    {
        var req = BuildExecuteRequest(@params);

        try
        {
            var capturer = _capturer.Value;
            var sta = _staWorker.Value;
            var result = sta.Invoke(() => capturer.Execute(req));
            return new
            {
                ok = result.Ok,
                message = result.Message,
                newValue = result.NewValue,
            };
        }
        catch (InvalidOperationException ex)
        {
            throw new RpcException(RpcError.InternalError, ex.Message);
        }
    }

    /// <summary>
    /// Run a sequence of actions inside the same STA invocation so the entire
    /// batch costs one stdio round-trip. Honours `onError: stop | continue`
    /// to abort or keep going past failures.
    /// </summary>
    private object HandleExecuteBatch(JsonElement @params)
    {
        if (!@params.TryGetProperty("actions", out var actionsEl) || actionsEl.ValueKind != JsonValueKind.Array)
        {
            throw new RpcException(RpcError.InvalidParams, "execute_batch requires an `actions` array.");
        }

        var stopOnError = (ReadString(@params, "onError") ?? "stop") != "continue";

        var requests = new List<UiaCapturer.ExecuteRequest>(actionsEl.GetArrayLength());
        foreach (var actionEl in actionsEl.EnumerateArray())
        {
            requests.Add(BuildExecuteRequest(actionEl));
        }

        var results = new List<object>(requests.Count);
        var allOk = true;

        try
        {
            var capturer = _capturer.Value;
            var sta = _staWorker.Value;
            sta.Invoke(() =>
            {
                foreach (var req in requests)
                {
                    var r = capturer.Execute(req);
                    results.Add(new { ok = r.Ok, message = r.Message, newValue = r.NewValue });
                    if (!r.Ok)
                    {
                        allOk = false;
                        if (stopOnError) break;
                    }
                }
            });
        }
        catch (InvalidOperationException ex)
        {
            throw new RpcException(RpcError.InternalError, ex.Message);
        }

        return new
        {
            results = results.ToArray(),
            allOk,
            executedCount = results.Count,
        };
    }

    /// <summary>
    /// Pull an ExecuteRequest out of a JSON params blob. Shared between the
    /// single-execute and batch-execute paths.
    /// </summary>
    private static UiaCapturer.ExecuteRequest BuildExecuteRequest(JsonElement @params)
    {
        return new UiaCapturer.ExecuteRequest
        {
            ElementId = ReadString(@params, "elementId")
                ?? throw new RpcException(RpcError.InvalidParams, "execute action requires `elementId`."),
            ActionType = ReadString(@params, "actionType") ?? "click",
            Text = ReadString(@params, "text"),
            Value = ReadString(@params, "value"),
            Checked = ReadBool(@params, "checked"),
            Expanded = ReadBool(@params, "expanded"),
            Key = ReadString(@params, "key"),
            Modifiers = ReadStringArray(@params, "modifiers"),
            ClearFirst = ReadBool(@params, "clearFirst") ?? false,
            TimeoutMs = ReadInt(@params, "timeoutMs") ?? 5000,
        };
    }

    private static string[]? ReadStringArray(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object) return null;
        if (!parent.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind != JsonValueKind.Array) return null;
        var list = new List<string>(v.GetArrayLength());
        foreach (var item in v.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String) list.Add(item.GetString()!);
        }
        return list.ToArray();
    }

    private static string? ReadString(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object) return null;
        if (!parent.TryGetProperty(name, out var v)) return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }

    private static int? ReadInt(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object) return null;
        if (!parent.TryGetProperty(name, out var v)) return null;
        return v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
    }

    private static bool? ReadBool(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object) return null;
        if (!parent.TryGetProperty(name, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }
}
