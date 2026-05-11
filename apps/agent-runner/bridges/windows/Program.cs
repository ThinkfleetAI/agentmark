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
        var dispatcher = new RpcDispatcher();

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
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

internal sealed class RpcDispatcher
{
    private static readonly string BridgeVersion = "0.4.0";

    public object? Dispatch(string method, JsonElement @params)
    {
        return method switch
        {
            "ping"         => HandlePing(),
            "capabilities" => HandleCapabilities(),
            _ => throw new RpcException(
                RpcError.MethodNotFound,
                $"Unknown method: {method}. Supported: ping, capabilities."),
        };
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
            // "capture" and "execute" land in Phase 0e2/0e3
        },
        uiaProvider = "FlaUI.UIA3",
        platform = "windows",
    };
}
