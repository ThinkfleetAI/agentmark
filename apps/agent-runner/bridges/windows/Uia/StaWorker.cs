// Single-threaded apartment (COM-STA) worker.
//
// UIA is COM-based and must be called from an STA thread. The bridge's
// main loop reads stdin on the default thread; we hand off any UIA work
// to a dedicated thread that lives for the lifetime of the process.
//
// Pattern: BlockingCollection<Action> queue, a single consumer thread.
// Caller blocks on a TaskCompletionSource so the dispatcher code reads
// linearly.

using System.Collections.Concurrent;

namespace AgentMark.Bridge.Windows.Uia;

internal sealed class StaWorker : IDisposable
{
    private readonly Thread _thread;
    private readonly BlockingCollection<Action> _queue = new();
    private volatile bool _disposed;

    public StaWorker()
    {
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "agentmark-uia-sta",
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    /// <summary>
    /// Run <paramref name="fn"/> on the STA thread and block until it finishes.
    /// Any exception is re-thrown on the calling thread.
    /// </summary>
    public T Invoke<T>(Func<T> fn)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(StaWorker));
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _queue.Add(() =>
        {
            try { tcs.TrySetResult(fn()); }
            catch (Exception ex) { tcs.TrySetException(ex); }
        });
        return tcs.Task.GetAwaiter().GetResult();
    }

    /// <summary>Void-returning convenience overload.</summary>
    public void Invoke(Action fn) => Invoke<object?>(() => { fn(); return null; });

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _queue.CompleteAdding();
        // We don't join the thread — it's a background thread and the
        // process is exiting anyway.
    }

    private void Run()
    {
        foreach (var action in _queue.GetConsumingEnumerable())
        {
            try { action(); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[bridge] STA worker swallowed: {ex}");
            }
        }
    }
}
