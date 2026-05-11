// DTOs the bridge returns over JSON-RPC. Field names match the
// AgentMark v0.4 DesktopCapture / DesktopElement spec exactly (camelCase
// after JsonNamingPolicy.CamelCase) so the Node-side WindowsUiaBackend
// can deserialize straight into the existing TypeScript types from
// @thinkfleet/agentmark.
//
// Keep this file the canonical source of truth for what we put on the
// wire — when the spec grows, mirror the change here.

using System.Text.Json.Serialization;

namespace AgentMark.Bridge.Windows.Uia;

/// <summary>
/// One window discoverable by list_windows. Includes just enough to let
/// the caller pick which window to capture in a subsequent call.
/// </summary>
internal sealed class WindowSummaryDto
{
    [JsonPropertyName("windowId")]
    public string WindowId { get; init; } = "";

    [JsonPropertyName("processName")]
    public string? ProcessName { get; init; }

    [JsonPropertyName("processId")]
    public int? ProcessId { get; init; }

    [JsonPropertyName("windowTitle")]
    public string WindowTitle { get; init; } = "";

    [JsonPropertyName("windowClass")]
    public string? WindowClass { get; init; }

    /// <summary>Whether this window currently has keyboard focus.</summary>
    [JsonPropertyName("hasFocus")]
    public bool HasFocus { get; init; }
}

/// <summary>
/// What `capture` returns. Mirrors the TS `DesktopCapture` interface.
/// </summary>
internal sealed class DesktopCaptureDto
{
    [JsonPropertyName("platform")]
    public string Platform => "windows";

    [JsonPropertyName("processName")]
    public string? ProcessName { get; init; }

    [JsonPropertyName("processId")]
    public int? ProcessId { get; init; }

    [JsonPropertyName("windowTitle")]
    public string WindowTitle { get; init; } = "";

    [JsonPropertyName("windowClass")]
    public string? WindowClass { get; init; }

    [JsonPropertyName("windowId")]
    public string WindowId { get; init; } = "";

    [JsonPropertyName("focusedElementId")]
    public string? FocusedElementId { get; init; }

    [JsonPropertyName("treeDepth")]
    public int TreeDepth { get; init; }

    [JsonPropertyName("elementCount")]
    public int ElementCount { get; init; }

    [JsonPropertyName("root")]
    public DesktopElementDto Root { get; init; } = null!;
}

/// <summary>
/// One node in the captured accessibility tree. Mirrors the TS
/// `DesktopElement` interface.
/// </summary>
internal sealed class DesktopElementDto
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("role")]
    public string Role { get; init; } = "other";

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("value")]
    public string? Value { get; init; }

    [JsonPropertyName("placeholder")]
    public string? Placeholder { get; init; }

    [JsonPropertyName("enabled")]
    public bool? Enabled { get; init; }

    [JsonPropertyName("selected")]
    public bool? Selected { get; init; }

    [JsonPropertyName("readOnly")]
    public bool? ReadOnly { get; init; }

    [JsonPropertyName("expanded")]
    public bool? Expanded { get; init; }

    [JsonPropertyName("aria")]
    public AriaStateDto? Aria { get; init; }

    [JsonPropertyName("bounds")]
    public BoundsDto? Bounds { get; init; }

    /// <summary>Mutable so the walker can backfill after building the
    /// parent. Stays null when an element is a leaf / depth-truncated.</summary>
    [JsonPropertyName("children")]
    public List<DesktopElementDto>? Children { get; set; }
}

internal sealed class AriaStateDto
{
    [JsonPropertyName("pressed")]
    public bool? Pressed { get; init; }

    [JsonPropertyName("checked")]
    public object? Checked { get; init; }  // bool | "mixed"

    [JsonPropertyName("required")]
    public bool? Required { get; init; }

    [JsonPropertyName("invalid")]
    public bool? Invalid { get; init; }
}

internal sealed class BoundsDto
{
    [JsonPropertyName("x")]
    public double X { get; init; }

    [JsonPropertyName("y")]
    public double Y { get; init; }

    [JsonPropertyName("width")]
    public double Width { get; init; }

    [JsonPropertyName("height")]
    public double Height { get; init; }
}
