/*
 * controller_shell.cpp — CHIP shell command sub-tree for the on-device
 * Matter commissioner.
 *
 * Registered into chip::Shell::Engine::Root() as a single "controller" command
 * that dispatches sub-commands.  The `matter` root is already registered by
 * MainLoopZephyr.cpp via SHELL_CMD_ARG_REGISTER — do NOT add another one here.
 *
 * Resulting command surface:
 *   matter controller pairing ble-thread <node> <datasetHex> <pin> <disc>
 *   matter controller pairing code       <node> <MT:.../manual>
 *   matter controller pairing unpair     <node>
 *   matter controller invoke-cmd         <node> <ep> <cluster> <cmd> [args...]
 *   matter controller read-attr          <node> <ep> <cluster> <attr>
 *   matter controller write-attr         <node> <ep> <cluster> <attr> <val>
 *   matter controller subs-attr          <node> <ep> <cluster> <attr> <min> <max>
 *
 * In plain English:
 * This file is the "type-in remote control" for the hub. When a person plugs into
 * the chip's USB/serial port they get a text prompt (a "shell") where they can type
 * commands. This file defines the "controller" family of those commands: pair a
 * brand-new smart device (over Bluetooth, then move it onto the Thread mesh),
 * remove a device, turn a light on/off or dim it, and read/write/subscribe to a
 * device's settings. Each command here does very little real work itself: it just
 * parses the words the person typed, packages them up, and hands the job over to
 * the single background "Matter thread" (where all the real Matter/Thread logic
 * must run). The heavy lifting lives in ControllerClient; this file is the
 * user-facing front door to it.
 */

#include "controller_shell.h"
#include "controller_client.h"
#include "thread_srp.h"

// CHIP / connectedhomeip includes
#include <app/AttributePathParams.h>
#include <app/InteractionModelEngine.h>
#include <app/ReadClient.h>
#include <app/ReadPrepareParams.h>
#include <app/WriteClient.h>
#include <app/clusters/on-off-server/on-off-server.h>
#include <controller/CHIPDeviceController.h>
#include <controller/CommissioningDelegate.h>
#include <controller/InvokeInteraction.h>
#include <controller/SetUpCodePairer.h>
#include <include/platform/PlatformManager.h>
#include <lib/core/CHIPError.h>
#include <lib/shell/Engine.h>
#include <lib/support/BytesToHex.h>
#include <lib/support/CodeUtils.h>
#include <lib/support/logging/CHIPLogging.h>
#include <protocols/secure_channel/RendezvousParameters.h>

// Zap-generated cluster objects (OnOff, LevelControl)
// TODO(verify): confirm these generated headers are compiled into the controller
// build target; they live in zzz_generated/app-common/app-common/zap-generated/.
#include <app-common/zap-generated/cluster-objects.h>

#include <cstdlib>
#include <cstring>

namespace nrf {
namespace controller {

// ---------------------------------------------------------------------------
// Module-level log tag
// ---------------------------------------------------------------------------
// A short label stamped onto every log line this file prints, so a person
// watching the serial output can tell these messages came from the shell code.
#define LOG_MODULE "CtrlShell"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// These small helpers turn the text a person typed (like "0x1234" or "42") into
// actual numbers the code can use. Each device gets a numeric "Node ID"; these also
// parse endpoint/cluster/attribute numbers, brightness levels, etc. Passing base 0
// to the C library means "auto-detect": a leading 0x is read as hex, otherwise decimal.

/// Parse a hex-encoded node ID string (0x-prefixed or plain hex).
// Turns the typed device ID (its numeric address on this home's network) into a NodeId.
static chip::NodeId ParseNodeId(const char * str)
{
    return static_cast<chip::NodeId>(strtoull(str, nullptr, 0));
}

/// Parse a generic uint64 (0x-prefixed or decimal).
// Read a large (up to 64-bit) number from text.
static uint64_t ParseU64(const char * str)
{
    return strtoull(str, nullptr, 0);
}

/// Parse a generic uint32.
// Read a 32-bit number from text (used for cluster/attribute IDs, values, etc.).
static uint32_t ParseU32(const char * str)
{
    return static_cast<uint32_t>(strtoul(str, nullptr, 0));
}

/// Parse a generic uint16.
// Read a 16-bit number from text (e.g. the discriminator or a subscribe interval).
static uint16_t ParseU16(const char * str)
{
    return static_cast<uint16_t>(strtoul(str, nullptr, 0));
}

/// Parse a generic uint8.
// Read a small (0-255) number from text (e.g. a brightness level 0-254).
static uint8_t ParseU8(const char * str)
{
    return static_cast<uint8_t>(strtoul(str, nullptr, 0));
}

// ---------------------------------------------------------------------------
// Minimal ReadClient::Callback implementation (used for read-attr)
// ---------------------------------------------------------------------------

// When we ask a device for the current value of one of its settings (an "attribute"),
// the answer comes back asynchronously. This little object is the set of callbacks
// Matter calls with the result: one for the data, one for errors, one when it's all
// done. It just logs what it hears. All of these run on the Matter thread.
class SimpleReadCallback : public chip::app::ReadClient::Callback
{
public:
    // Called when the device sends back the value we asked for. We just log which
    // endpoint/cluster/attribute answered (or log an error status if it refused).
    void OnAttributeData(const chip::app::ConcreteDataAttributePath & path,
                         chip::TLV::TLVReader * data,
                         const chip::app::StatusIB & status) override
    {
        if (status.IsSuccess())
        {
            ChipLogProgress(NotSpecified, "[%s] OnAttributeData ep=%u cluster=0x%04X attr=0x%04X",
                            LOG_MODULE, path.mEndpointId, path.mClusterId, path.mAttributeId);
        }
        else
        {
            ChipLogError(NotSpecified, "[%s] OnAttributeData error status=0x%02X",
                         LOG_MODULE, chip::to_underlying(status.mStatus));
        }
    }

    // Called if the whole read failed (e.g. the device is unreachable). Just logs it.
    void OnError(CHIP_ERROR error) override
    {
        ChipLogError(NotSpecified, "[%s] ReadClient error: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
    }

    // Called once the read is completely finished. This is where we clean up: both
    // the read machinery and this callback object were created with heap memory, so
    // we free them here to avoid a leak (they aren't needed once the read is over).
    void OnDone(chip::app::ReadClient * client) override
    {
        ChipLogProgress(NotSpecified, "[%s] ReadClient done", LOG_MODULE);
        // Self-delete: heap client was allocated in the handler.
        chip::Platform::Delete(client);
        chip::Platform::Delete(this);
    }
};

// ---------------------------------------------------------------------------
// Minimal ReadClient::Callback implementation (used for subs-attr)
// Heap-allocated; self-managed lifetime via OnDone.
// ---------------------------------------------------------------------------

// Like SimpleReadCallback above, but for a SUBSCRIPTION: instead of asking once, we
// ask the device to keep pushing us the value whenever it changes (e.g. a light
// reporting its on/off state). This object receives each pushed update and logs it.
// It lives on the heap and cleans itself up when the subscription ends. All callbacks
// run on the Matter thread.
class SimpleSubscribeCallback : public chip::app::ReadClient::Callback
{
public:
    // [rank 6] The auto-resubscribing ReadClient rebuilds its path Span from this
    // pointer on EVERY resubscription, so the storage must outlive the ReadClient.
    // Keep it in the callback (destroyed in OnDone == ReadClient lifetime), NOT on
    // the caller's stack. OnDeallocatePaths is a no-op: the storage is callback-owned.
    // Which endpoint/cluster/attribute we're subscribed to. Kept here (not on a
    // temporary stack variable) because a subscription can automatically re-establish
    // itself later and needs this to still exist then.
    chip::app::AttributePathParams mAttrPath;
    // Matter would normally call this to free the subscribe path; we own the storage
    // ourselves (it's the member above), so there's nothing to free here.
    void OnDeallocatePaths(chip::app::ReadPrepareParams &&) override {}

    // Called each time the device pushes us a new value for the watched attribute.
    // We just log which endpoint/cluster/attribute reported (or the error status).
    void OnAttributeData(const chip::app::ConcreteDataAttributePath & path,
                         chip::TLV::TLVReader * data,
                         const chip::app::StatusIB & status) override
    {
        if (status.IsSuccess())
        {
            ChipLogProgress(NotSpecified, "[%s] SubsData ep=%u cluster=0x%04X attr=0x%04X",
                            LOG_MODULE, path.mEndpointId, path.mClusterId, path.mAttributeId);
        }
        else
        {
            ChipLogError(NotSpecified, "[%s] SubsData error 0x%02X",
                         LOG_MODULE, chip::to_underlying(status.mStatus));
        }
    }

    // Called once the subscription is up and running. The device has agreed to keep
    // us updated; we log the ID the network assigned to this subscription.
    void OnSubscriptionEstablished(chip::SubscriptionId subscriptionId) override
    {
        ChipLogProgress(NotSpecified, "[%s] Subscription established id=0x%08X", LOG_MODULE, subscriptionId);
    }

    // Called if the subscription hits an error. Just logs it.
    void OnError(CHIP_ERROR error) override
    {
        ChipLogError(NotSpecified, "[%s] Subscription error: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
    }

    // Called when the subscription is permanently finished/terminated. We free both
    // the subscription machinery and this callback object (they were heap-allocated).
    void OnDone(chip::app::ReadClient * client) override
    {
        ChipLogProgress(NotSpecified, "[%s] Subscription done / terminated", LOG_MODULE);
        // Per ReadClient.h lines 331-337: deleting client before OnDone suppresses the
        // callback. Delete both here on termination.
        chip::Platform::Delete(client);
        chip::Platform::Delete(this);
    }
};

// ---------------------------------------------------------------------------
// Minimal WriteClient::Callback implementation
// ---------------------------------------------------------------------------

// When we change one of a device's settings (write an attribute), the device replies
// with success/failure. This object receives that reply and logs it, then cleans up.
// All callbacks run on the Matter thread.
class SimpleWriteCallback : public chip::app::WriteClient::Callback
{
public:
    // Called with the device's answer to our write: success (value changed) or a
    // failure status. We just log the outcome.
    void OnResponse(const chip::app::WriteClient * client,
                    const chip::app::ConcreteDataAttributePath & path,
                    chip::app::StatusIB status) override
    {
        if (status.IsSuccess())
        {
            ChipLogProgress(NotSpecified, "[%s] WriteAttr success ep=%u cluster=0x%04X attr=0x%04X",
                            LOG_MODULE, path.mEndpointId, path.mClusterId, path.mAttributeId);
        }
        else
        {
            ChipLogError(NotSpecified, "[%s] WriteAttr failed 0x%02X",
                         LOG_MODULE, chip::to_underlying(status.mStatus));
        }
    }

    // Called if the write failed at the transport level (e.g. device unreachable).
    void OnError(const chip::app::WriteClient * client, CHIP_ERROR error) override
    {
        ChipLogError(NotSpecified, "[%s] WriteClient error: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
    }

    // Called when the write is fully finished; frees the heap-allocated write
    // machinery and this callback object.
    void OnDone(chip::app::WriteClient * client) override
    {
        ChipLogProgress(NotSpecified, "[%s] WriteClient done", LOG_MODULE);
        chip::Platform::Delete(client);
        chip::Platform::Delete(this);
    }
};

// ---------------------------------------------------------------------------
// ScheduleWork context structs
// ---------------------------------------------------------------------------

// The shell commands run on the shell/serial thread, but the real Matter work must
// run on the one Matter thread. To hand a job across, we bundle the typed-in details
// into one of these little "context" structs, then ask the Matter thread to run it
// later ("ScheduleWork"). Each struct below is the parcel of data for one command.

// Parcel for "pairing ble-thread": add a brand-new device by first reaching it over
// Bluetooth, then handing it this home's Thread network credentials.
struct PairBleThreadCtx
{
    // The device's numeric ID we want to assign it once it joins.
    chip::NodeId  nodeId;
    // The device's secret setup passcode (from its QR code/label) that proves we may pair.
    uint32_t      pinCode;
    // The short number the device broadcasts so we can pick it out from other nearby devices.
    uint16_t      discriminator;
    // The Thread network "name + password" blob to hand the device so it can join the mesh.
    uint8_t       datasetTlv[256]; // max OT dataset is ~254 bytes
    // How many bytes of the above blob are actually used.
    size_t        datasetLen;
};

// Parcel for "pairing code": add a device using its full setup code (QR "MT:..." or
// the manual digit string), which contains the passcode+discriminator together.
struct PairCodeCtx
{
    // The device ID to assign.
    chip::NodeId nodeId;
    // The raw setup code text the person typed.
    char         setupCode[128];
};

// Parcel for "pairing unpair": remove a device from this home's network.
struct UnpairCtx
{
    // Which device to forget.
    chip::NodeId nodeId;
};

// Parcel for "invoke-cmd": tell a device to DO something (turn on/off, set brightness).
struct InvokeCmdCtx
{
    // Which device to command.
    chip::NodeId      nodeId;
    // Which sub-device inside it (e.g. endpoint 1 = the light).
    chip::EndpointId  endpointId;
    // Which feature group the command belongs to (OnOff = on/off, LevelControl = brightness).
    chip::ClusterId   clusterId;
    // Which specific command in that group (e.g. On, Off, Toggle, MoveToLevel).
    chip::CommandId   commandId;
    uint8_t           level;          // used for MoveToLevel
};

// Parcel for "read-attr": ask a device for the current value of one of its settings.
struct ReadAttrCtx
{
    // Which device to ask.
    chip::NodeId      nodeId;
    // Which sub-device (endpoint) inside it.
    chip::EndpointId  endpointId;
    // Which feature group (cluster) the setting lives in.
    chip::ClusterId   clusterId;
    // Which specific setting (attribute) we want to read.
    chip::AttributeId attributeId;
};

// Parcel for "write-attr": change one of a device's settings to a new value.
struct WriteAttrCtx
{
    // Which device, sub-device, feature group and setting to change.
    chip::NodeId      nodeId;
    chip::EndpointId  endpointId;
    chip::ClusterId   clusterId;
    chip::AttributeId attributeId;
    uint32_t          value; // simple integer write; extend as needed
};

// Parcel for "subs-attr": ask a device to keep pushing us a setting's value as it changes.
struct SubsAttrCtx
{
    // Which device, sub-device, feature group and setting to watch.
    chip::NodeId      nodeId;
    chip::EndpointId  endpointId;
    chip::ClusterId   clusterId;
    chip::AttributeId attributeId;
    // Fastest we want updates (won't report more often than this many seconds apart)...
    uint16_t          minIntervalSec;
    // ...and slowest (the device must report at least this often even if nothing changed).
    uint16_t          maxIntervalSec;
};

// ---------------------------------------------------------------------------
// GetConnectedDevice callback wrappers for invoke / read / write / subscribe
// ---------------------------------------------------------------------------

// Before we can command or query a device, we first need a live, secure connection to
// it over Thread. Asking for that connection is asynchronous, so for each command we
// build one of these wrapper objects: it holds the command details plus two callbacks
// — one that fires once the connection is ready ("OnConnected"), and one that fires if
// connecting failed ("OnFailure"). Both callbacks run on the Matter thread.

// --- invoke-cmd ---

// Wrapper for the "invoke-cmd" flow: once connected, actually send the On/Off/Toggle
// or MoveToLevel command to the device.
struct InvokeOnConnectedCtx
{
    // The command details (which device, endpoint, cluster, command, level).
    InvokeCmdCtx cmd;
    // Fired when the secure connection to the device is ready.
    chip::Callback::Callback<chip::OnDeviceConnected>        onConnected;
    // Fired if we couldn't connect.
    chip::Callback::Callback<chip::OnDeviceConnectionFailure> onFailure;

    // Wire the two callbacks to the static functions below and pass "this" so those
    // functions can find our command details.
    InvokeOnConnectedCtx() :
        onConnected(OnConnected, this),
        onFailure(OnFailure, this) {}

    // Runs (on the Matter thread) once we have a live secure session to the device.
    // Looks at which cluster/command was requested and sends the matching Matter
    // command, logging success or failure. Frees this wrapper when done.
    static void OnConnected(void * ctx, chip::Messaging::ExchangeManager & exchangeMgr,
                            const chip::SessionHandle & session)
    {
        auto * self = static_cast<InvokeOnConnectedCtx *>(ctx);
        CHIP_ERROR err = CHIP_NO_ERROR;

        using namespace chip::app::Clusters;
        // "No special reply deadline" — use the device's default timing.
        const chip::Optional<uint16_t> noTimeout = chip::NullOptional;

        // Figure out which command was asked for by matching the cluster (feature
        // group) and command number, then send the corresponding typed request.
        // Dispatch based on cluster + command ID
        if (self->cmd.clusterId == OnOff::Id)
        {
            // Turn the device ON.
            if (self->cmd.commandId == OnOff::Commands::On::Id)
            {
                OnOff::Commands::On::Type req{};
                err = chip::Controller::InvokeCommandRequest(&exchangeMgr, session,
                                                             self->cmd.endpointId, req,
                                                             [](const chip::app::ConcreteCommandPath &,
                                                                const chip::app::StatusIB &,
                                                                const chip::app::DataModel::NullObjectType &) {
                                                                 ChipLogProgress(NotSpecified, "[%s] On success", LOG_MODULE);
                                                             },
                                                             [](CHIP_ERROR e) {
                                                                 ChipLogError(NotSpecified, "[%s] On error: %" CHIP_ERROR_FORMAT, LOG_MODULE, e.Format());
                                                             },
                                                             noTimeout);
            }
            // Turn the device OFF.
            else if (self->cmd.commandId == OnOff::Commands::Off::Id)
            {
                OnOff::Commands::Off::Type req{};
                err = chip::Controller::InvokeCommandRequest(&exchangeMgr, session,
                                                             self->cmd.endpointId, req,
                                                             [](const chip::app::ConcreteCommandPath &,
                                                                const chip::app::StatusIB &,
                                                                const chip::app::DataModel::NullObjectType &) {
                                                                 ChipLogProgress(NotSpecified, "[%s] Off success", LOG_MODULE);
                                                             },
                                                             [](CHIP_ERROR e) {
                                                                 ChipLogError(NotSpecified, "[%s] Off error: %" CHIP_ERROR_FORMAT, LOG_MODULE, e.Format());
                                                             },
                                                             noTimeout);
            }
            // Flip the device to the opposite of its current on/off state.
            else if (self->cmd.commandId == OnOff::Commands::Toggle::Id)
            {
                OnOff::Commands::Toggle::Type req{};
                err = chip::Controller::InvokeCommandRequest(&exchangeMgr, session,
                                                             self->cmd.endpointId, req,
                                                             [](const chip::app::ConcreteCommandPath &,
                                                                const chip::app::StatusIB &,
                                                                const chip::app::DataModel::NullObjectType &) {
                                                                 ChipLogProgress(NotSpecified, "[%s] Toggle success", LOG_MODULE);
                                                             },
                                                             [](CHIP_ERROR e) {
                                                                 ChipLogError(NotSpecified, "[%s] Toggle error: %" CHIP_ERROR_FORMAT, LOG_MODULE, e.Format());
                                                             },
                                                             noTimeout);
            }
            // Anything else in the OnOff group isn't handled here.
            else
            {
                ChipLogError(NotSpecified, "[%s] invoke-cmd: unknown OnOff command 0x%02X", LOG_MODULE, self->cmd.commandId);
            }
        }
        // Brightness control.
        else if (self->cmd.clusterId == LevelControl::Id)
        {
            // Set the brightness to a specific level (0-254).
            if (self->cmd.commandId == LevelControl::Commands::MoveToLevel::Id)
            {
                LevelControl::Commands::MoveToLevel::Type req{};
                // The desired brightness.
                req.level             = self->cmd.level;
                // Transition instantly (0 = no fade).
                req.transitionTime.SetNonNull(static_cast<uint16_t>(0));
                // No special option flags.
                req.optionsMask       = chip::BitMask<LevelControl::OptionsBitmap>(0);
                req.optionsOverride   = chip::BitMask<LevelControl::OptionsBitmap>(0);
                err = chip::Controller::InvokeCommandRequest(&exchangeMgr, session,
                                                             self->cmd.endpointId, req,
                                                             [](const chip::app::ConcreteCommandPath &,
                                                                const chip::app::StatusIB &,
                                                                const chip::app::DataModel::NullObjectType &) {
                                                                 ChipLogProgress(NotSpecified, "[%s] MoveToLevel success", LOG_MODULE);
                                                             },
                                                             [](CHIP_ERROR e) {
                                                                 ChipLogError(NotSpecified, "[%s] MoveToLevel error: %" CHIP_ERROR_FORMAT, LOG_MODULE, e.Format());
                                                             },
                                                             noTimeout);
            }
            // Anything else in the brightness group isn't handled here.
            else
            {
                ChipLogError(NotSpecified, "[%s] invoke-cmd: unknown LevelControl command 0x%02X", LOG_MODULE, self->cmd.commandId);
            }
        }
        // Only OnOff and brightness are wired up here; other feature groups aren't supported.
        else
        {
            ChipLogError(NotSpecified, "[%s] invoke-cmd: unsupported cluster 0x%04X — use CommandSender directly",
                         LOG_MODULE, self->cmd.clusterId);
            err = CHIP_ERROR_NOT_IMPLEMENTED;
        }

        // Log if kicking off the request failed (the success/failure of the command
        // itself arrives later via the lambdas passed above).
        if (err != CHIP_NO_ERROR)
        {
            ChipLogError(NotSpecified, "[%s] InvokeCommandRequest failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
        }

        // Done with this wrapper; free it.
        chip::Platform::Delete(self);
    }

    // Runs (on the Matter thread) if we couldn't get a connection to the device.
    // Logs the error and frees the wrapper.
    static void OnFailure(void * ctx, const chip::ScopedNodeId & peerId, CHIP_ERROR error)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (invoke) failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
        auto * self = static_cast<InvokeOnConnectedCtx *>(ctx);
        chip::Platform::Delete(self);
    }
};

// --- read-attr ---

// Wrapper for the "read-attr" flow: once connected, ask the device for one setting's value.
struct ReadOnConnectedCtx
{
    // What to read (device/endpoint/cluster/attribute).
    ReadAttrCtx attr;
    // Fired when the connection is ready / when it failed.
    chip::Callback::Callback<chip::OnDeviceConnected>         onConnected;
    chip::Callback::Callback<chip::OnDeviceConnectionFailure> onFailure;

    // Wire the callbacks to the static functions below, passing "this" as context.
    ReadOnConnectedCtx() :
        onConnected(OnConnected, this),
        onFailure(OnFailure, this) {}

    // Runs (on the Matter thread) once connected. Builds and fires a one-shot read
    // request for the target attribute; the answer arrives later via SimpleReadCallback.
    static void OnConnected(void * ctx, chip::Messaging::ExchangeManager & exchangeMgr,
                            const chip::SessionHandle & session)
    {
        auto * self = static_cast<ReadOnConnectedCtx *>(ctx);

        // The address of the exact setting we want: endpoint + cluster + attribute.
        chip::app::AttributePathParams attrPath(self->attr.endpointId,
                                                self->attr.clusterId,
                                                self->attr.attributeId);

        // Bundle up the read request over this secure session, for that one setting.
        chip::app::ReadPrepareParams params(session);
        params.mpAttributePathParamsList    = &attrPath;
        params.mAttributePathParamsListSize = 1;

        // Allocate the callback (receives the answer) and the read engine on the heap;
        // they clean themselves up when the read finishes.
        auto * cb     = chip::Platform::New<SimpleReadCallback>();
        auto * client = chip::Platform::New<chip::app::ReadClient>(
            chip::app::InteractionModelEngine::GetInstance(),
            &exchangeMgr,
            *cb,
            chip::app::ReadClient::InteractionType::Read);

        // If we ran out of memory allocating either, clean up and bail.
        if (cb == nullptr || client == nullptr)
        {
            ChipLogError(NotSpecified, "[%s] read-attr: OOM allocating ReadClient/Callback", LOG_MODULE);
            if (cb)     chip::Platform::Delete(cb);
            if (client) chip::Platform::Delete(client);
            chip::Platform::Delete(self);
            return;
        }

        // Actually send the read out onto the network.
        CHIP_ERROR err = client->SendRequest(params);
        if (err != CHIP_NO_ERROR)
        {
            // Send failed to even start; free what we allocated.
            ChipLogError(NotSpecified, "[%s] ReadClient::SendRequest failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
            chip::Platform::Delete(client);
            chip::Platform::Delete(cb);
        }
        // On success: client + cb lifetime managed by OnDone callback.

        // The wrapper's job (kick off the read) is done regardless; free it.
        chip::Platform::Delete(self);
    }

    // Runs (on the Matter thread) if connecting to the device failed. Logs and frees.
    static void OnFailure(void * ctx, const chip::ScopedNodeId & peerId, CHIP_ERROR error)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (read) failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
        chip::Platform::Delete(static_cast<ReadOnConnectedCtx *>(ctx));
    }
};

// --- write-attr ---

// Wrapper for the "write-attr" flow: once connected, change one setting on the device.
struct WriteOnConnectedCtx
{
    // What to write (device/endpoint/cluster/attribute + the new value).
    WriteAttrCtx attr;
    // Fired when the connection is ready / when it failed.
    chip::Callback::Callback<chip::OnDeviceConnected>         onConnected;
    chip::Callback::Callback<chip::OnDeviceConnectionFailure> onFailure;

    // Wire the callbacks to the static functions below, passing "this" as context.
    WriteOnConnectedCtx() :
        onConnected(OnConnected, this),
        onFailure(OnFailure, this) {}

    // Runs (on the Matter thread) once connected. Encodes the new value, sends the
    // write, and lets SimpleWriteCallback report the device's reply.
    static void OnConnected(void * ctx, chip::Messaging::ExchangeManager & exchangeMgr,
                            const chip::SessionHandle & session)
    {
        auto * self = static_cast<WriteOnConnectedCtx *>(ctx);

        // The address of the exact setting to change.
        chip::app::AttributePathParams attrPath(self->attr.endpointId,
                                                self->attr.clusterId,
                                                self->attr.attributeId);

        // Allocate the reply callback and the write engine (heap; self-cleaning).
        auto * cb = chip::Platform::New<SimpleWriteCallback>();
        auto * wc = chip::Platform::New<chip::app::WriteClient>(
            &exchangeMgr, cb, chip::NullOptional /* no timed write */);

        // Out of memory: clean up and bail.
        if (cb == nullptr || wc == nullptr)
        {
            ChipLogError(NotSpecified, "[%s] write-attr: OOM allocating WriteClient/Callback", LOG_MODULE);
            if (cb) chip::Platform::Delete(cb);
            if (wc) chip::Platform::Delete(wc);
            chip::Platform::Delete(self);
            return;
        }

        // Pack the new value into the write. Note: we always encode it as a plain
        // 32-bit number, so this only works for settings that accept that shape.
        // Encode value as uint32 — caller must ensure the attribute accepts this type.
        // TODO(verify): for typed attributes (bool, enum8, etc.) the encoded type must
        // match the ZCL attribute type; a uint32 encode will fail validation for
        // narrower types.  A generic JSON->TLV path would be needed for full coverage.
        CHIP_ERROR err = wc->EncodeAttribute(attrPath, self->attr.value);
        if (err != CHIP_NO_ERROR)
        {
            // Encoding failed (e.g. type mismatch); clean up and stop.
            ChipLogError(NotSpecified, "[%s] EncodeAttribute failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
            chip::Platform::Delete(wc);
            chip::Platform::Delete(cb);
            chip::Platform::Delete(self);
            return;
        }

        // Send the write out onto the network; the reply arrives via SimpleWriteCallback.
        err = wc->SendWriteRequest(session);
        if (err != CHIP_NO_ERROR)
        {
            ChipLogError(NotSpecified, "[%s] SendWriteRequest failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
            chip::Platform::Delete(wc);
            chip::Platform::Delete(cb);
        }

        // Wrapper's job is done; free it.
        chip::Platform::Delete(self);
    }

    // Runs (on the Matter thread) if connecting to the device failed. Logs and frees.
    static void OnFailure(void * ctx, const chip::ScopedNodeId & peerId, CHIP_ERROR error)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (write) failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
        chip::Platform::Delete(static_cast<WriteOnConnectedCtx *>(ctx));
    }
};

// --- subs-attr ---

// Wrapper for the "subs-attr" flow: once connected, set up an ongoing subscription so
// the device keeps pushing us a setting's value as it changes.
struct SubsOnConnectedCtx
{
    // What to watch and how often (device/endpoint/cluster/attribute + min/max interval).
    SubsAttrCtx subs;
    // Fired when the connection is ready / when it failed.
    chip::Callback::Callback<chip::OnDeviceConnected>         onConnected;
    chip::Callback::Callback<chip::OnDeviceConnectionFailure> onFailure;

    // Wire the callbacks to the static functions below, passing "this" as context.
    SubsOnConnectedCtx() :
        onConnected(OnConnected, this),
        onFailure(OnFailure, this) {}

    // Runs (on the Matter thread) once connected. Starts an auto-renewing subscription;
    // updates arrive via SimpleSubscribeCallback until it's torn down.
    static void OnConnected(void * ctx, chip::Messaging::ExchangeManager & exchangeMgr,
                            const chip::SessionHandle & session)
    {
        auto * self = static_cast<SubsOnConnectedCtx *>(ctx);

        // [rank 6] Allocate the callback FIRST and store the path IN it, so the path
        // outlives the ReadClient across auto-resubscriptions (was a stack local ->
        // use-after-free on the first resubscribe).
        auto * cb = chip::Platform::New<SimpleSubscribeCallback>();
        if (cb == nullptr)
        {
            ChipLogError(NotSpecified, "[%s] subs-attr: OOM allocating Callback", LOG_MODULE);
            chip::Platform::Delete(self);
            return;
        }
        // Store the watched setting's address inside the callback (see the note above
        // its mAttrPath member for why it must live there, not on the stack).
        cb->mAttrPath = chip::app::AttributePathParams(self->subs.endpointId,
                                                       self->subs.clusterId,
                                                       self->subs.attributeId);

        // Bundle up the subscription request: which setting, and the fastest/slowest
        // reporting intervals we asked for.
        chip::app::ReadPrepareParams params(session);
        params.mpAttributePathParamsList    = &cb->mAttrPath;
        params.mAttributePathParamsListSize = 1;
        params.mMinIntervalFloorSeconds     = self->subs.minIntervalSec;
        params.mMaxIntervalCeilingSeconds   = self->subs.maxIntervalSec;

        // Allocate the read engine in "subscribe" mode (heap; self-cleaning via OnDone).
        auto * client = chip::Platform::New<chip::app::ReadClient>(
            chip::app::InteractionModelEngine::GetInstance(),
            &exchangeMgr,
            *cb,
            chip::app::ReadClient::InteractionType::Subscribe);
        if (client == nullptr)
        {
            ChipLogError(NotSpecified, "[%s] subs-attr: OOM allocating ReadClient", LOG_MODULE);
            chip::Platform::Delete(cb);
            chip::Platform::Delete(self);
            return;
        }

        // Start the subscription. "AutoResubscribe" means it will automatically try to
        // re-establish itself if the connection drops, so it keeps running long-term.
        CHIP_ERROR err = client->SendAutoResubscribeRequest(std::move(params));
        if (err != CHIP_NO_ERROR)
        {
            ChipLogError(NotSpecified, "[%s] SendAutoResubscribeRequest failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
            chip::Platform::Delete(client);
            chip::Platform::Delete(cb);
        }

        // Wrapper's job is done; free it.
        chip::Platform::Delete(self);
    }

    // Runs (on the Matter thread) if connecting to the device failed. Logs and frees.
    static void OnFailure(void * ctx, const chip::ScopedNodeId & peerId, CHIP_ERROR error)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (subs) failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, error.Format());
        chip::Platform::Delete(static_cast<SubsOnConnectedCtx *>(ctx));
    }
};

// ---------------------------------------------------------------------------
// ScheduleWork trampoline functions (run on Matter thread)
// ---------------------------------------------------------------------------

// These "Do..." functions are the landing point on the Matter thread. Each shell
// handler packages a context struct and asks the Matter thread to run the matching
// one of these; it unpacks the parcel, calls the real ControllerClient work, and
// frees the parcel. They always run on the Matter thread (never the shell thread).

// Pair a new device over Bluetooth then move it onto Thread, using the packaged
// node ID / passcode / discriminator / Thread credentials.
static void DoPairBleThread(intptr_t arg)
{
    auto * ctx = reinterpret_cast<PairBleThreadCtx *>(arg);

    CHIP_ERROR err = ControllerClient::Instance().PairBleThread(
        ctx->nodeId, ctx->pinCode, ctx->discriminator,
        ctx->datasetTlv, ctx->datasetLen);

    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(NotSpecified, "[%s] PairBleThread failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
    }

    chip::Platform::Delete(ctx);
}

// Pair a new device using its full setup code (QR/manual), which bundles the
// passcode and discriminator together.
static void DoPairCode(intptr_t arg)
{
    auto * ctx = reinterpret_cast<PairCodeCtx *>(arg);

    CHIP_ERROR err = ControllerClient::Instance().PairCode(ctx->nodeId, ctx->setupCode);
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(NotSpecified, "[%s] PairCode failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
    }

    chip::Platform::Delete(ctx);
}

// Remove a device from this home's network.
static void DoUnpair(intptr_t arg)
{
    auto * ctx = reinterpret_cast<UnpairCtx *>(arg);

    CHIP_ERROR err = ControllerClient::Instance().Unpair(ctx->nodeId);
    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(NotSpecified, "[%s] Unpair failed: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
    }

    chip::Platform::Delete(ctx);
}

// Send a command (on/off/toggle/brightness) to a device. First it asks the
// Commissioner for a live connection; the actual command is sent later from
// InvokeOnConnectedCtx::OnConnected once that connection is ready.
static void DoInvokeCmd(intptr_t arg)
{
    auto * cmdCtx = reinterpret_cast<InvokeCmdCtx *>(arg);

    auto * connCtx = chip::Platform::New<InvokeOnConnectedCtx>();
    if (connCtx == nullptr)
    {
        ChipLogError(NotSpecified, "[%s] invoke-cmd: OOM for connection context", LOG_MODULE);
        chip::Platform::Delete(cmdCtx);
        return;
    }
    // Move the command details into the connection wrapper, then free the parcel.
    connCtx->cmd = *cmdCtx;
    chip::Platform::Delete(cmdCtx);

    // Ask for a live secure connection to the target device; OnConnected/OnFailure fire later.
    CHIP_ERROR err = ControllerClient::Instance().Commissioner().GetConnectedDevice(
        connCtx->cmd.nodeId, &connCtx->onConnected, &connCtx->onFailure);

    if (err != CHIP_NO_ERROR)
    {
        // Couldn't even start connecting; clean up the wrapper.
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (invoke) error: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
        chip::Platform::Delete(connCtx);
    }
}

// Read one setting from a device. Like DoInvokeCmd, it first requests a connection;
// the read is sent from ReadOnConnectedCtx::OnConnected once connected.
static void DoReadAttr(intptr_t arg)
{
    auto * attrCtx = reinterpret_cast<ReadAttrCtx *>(arg);

    auto * connCtx = chip::Platform::New<ReadOnConnectedCtx>();
    if (connCtx == nullptr)
    {
        ChipLogError(NotSpecified, "[%s] read-attr: OOM for connection context", LOG_MODULE);
        chip::Platform::Delete(attrCtx);
        return;
    }
    // Move the read details into the wrapper, then free the parcel.
    connCtx->attr = *attrCtx;
    chip::Platform::Delete(attrCtx);

    // Ask for a live connection; the read happens later in OnConnected.
    CHIP_ERROR err = ControllerClient::Instance().Commissioner().GetConnectedDevice(
        connCtx->attr.nodeId, &connCtx->onConnected, &connCtx->onFailure);

    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (read) error: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
        chip::Platform::Delete(connCtx);
    }
}

// Write one setting on a device. Requests a connection first; the write is sent from
// WriteOnConnectedCtx::OnConnected once connected.
static void DoWriteAttr(intptr_t arg)
{
    auto * attrCtx = reinterpret_cast<WriteAttrCtx *>(arg);

    auto * connCtx = chip::Platform::New<WriteOnConnectedCtx>();
    if (connCtx == nullptr)
    {
        ChipLogError(NotSpecified, "[%s] write-attr: OOM for connection context", LOG_MODULE);
        chip::Platform::Delete(attrCtx);
        return;
    }
    // Move the write details into the wrapper, then free the parcel.
    connCtx->attr = *attrCtx;
    chip::Platform::Delete(attrCtx);

    // Ask for a live connection; the write happens later in OnConnected.
    CHIP_ERROR err = ControllerClient::Instance().Commissioner().GetConnectedDevice(
        connCtx->attr.nodeId, &connCtx->onConnected, &connCtx->onFailure);

    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (write) error: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
        chip::Platform::Delete(connCtx);
    }
}

// Start watching one setting on a device (subscription). Requests a connection first;
// the subscription is set up from SubsOnConnectedCtx::OnConnected once connected.
static void DoSubsAttr(intptr_t arg)
{
    auto * subsCtx = reinterpret_cast<SubsAttrCtx *>(arg);

    auto * connCtx = chip::Platform::New<SubsOnConnectedCtx>();
    if (connCtx == nullptr)
    {
        ChipLogError(NotSpecified, "[%s] subs-attr: OOM for connection context", LOG_MODULE);
        chip::Platform::Delete(subsCtx);
        return;
    }
    // Move the subscription details into the wrapper, then free the parcel.
    connCtx->subs = *subsCtx;
    chip::Platform::Delete(subsCtx);

    // Ask for a live connection; the subscription starts later in OnConnected.
    CHIP_ERROR err = ControllerClient::Instance().Commissioner().GetConnectedDevice(
        connCtx->subs.nodeId, &connCtx->onConnected, &connCtx->onFailure);

    if (err != CHIP_NO_ERROR)
    {
        ChipLogError(NotSpecified, "[%s] GetConnectedDevice (subs) error: %" CHIP_ERROR_FORMAT, LOG_MODULE, err.Format());
        chip::Platform::Delete(connCtx);
    }
}

// ---------------------------------------------------------------------------
// Shell handler: pairing sub-commands
// ---------------------------------------------------------------------------

// Handles "pairing ble-thread": validate the typed arguments, work out the Thread
// credentials to use, package everything, and schedule the real pairing on the Matter
// thread. Runs on the shell thread when the person hits enter.
// matter controller pairing ble-thread <node> <datasetHex> <pin> <disc>
static CHIP_ERROR HandlePairingBleThread(int argc, char * argv[])
{
    // argc/argv here are the tokens AFTER "ble-thread" has been consumed by
    // the parent dispatch, so argv[0..3] = node, datasetHex|"self", pin, disc.
    // Require exactly the four expected arguments, else print usage and stop.
    VerifyOrReturnError(argc == 4, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: pairing ble-thread <node> <datasetHex|self> <pin> <disc>", LOG_MODULE));

    // Allocate the parcel to carry the details to the Matter thread.
    auto * ctx = chip::Platform::New<PairBleThreadCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    // Pull the numbers out of the typed arguments.
    ctx->nodeId        = ParseNodeId(argv[0]);
    ctx->pinCode       = ParseU32(argv[2]);
    ctx->discriminator = ParseU16(argv[3]);

    // Second argument is either the literal word "self" or a hex blob of Thread credentials.
    const char * hexStr = argv[1];
    if (strcmp(hexStr, "self") == 0)
    {
        // Commission the node onto THIS controller's own Thread network (the DK is
        // the leader). Pull the active operational dataset straight from OpenThread
        // so the user never has to copy a hex blob.
        size_t     dsLen = 0;
        CHIP_ERROR e     = GetActiveDatasetTlvs(ctx->datasetTlv, sizeof(ctx->datasetTlv), dsLen);
        if (e != CHIP_NO_ERROR)
        {
            ChipLogError(NotSpecified, "[%s] pairing ble-thread self: GetActiveDatasetTlvs failed: %" CHIP_ERROR_FORMAT,
                         LOG_MODULE, e.Format());
            chip::Platform::Delete(ctx);
            return e;
        }
        ctx->datasetLen = dsLen;
        ChipLogProgress(NotSpecified, "[%s] pairing ble-thread: using controller's own dataset (%u bytes)",
                        LOG_MODULE, static_cast<unsigned>(dsLen));
    }
    else
    {
        // Otherwise the person supplied the Thread credentials directly as a hex string;
        // turn that text back into the raw bytes.
        // Hex-decode the supplied Thread operational dataset.
        size_t hexLen   = strlen(hexStr);
        size_t bytesLen = chip::Encoding::HexToBytes(hexStr, hexLen, ctx->datasetTlv, sizeof(ctx->datasetTlv));
        // If decoding produced nothing from a non-empty string, the hex was malformed.
        if (bytesLen == 0 && hexLen != 0)
        {
            ChipLogError(NotSpecified, "[%s] pairing ble-thread: invalid dataset hex string", LOG_MODULE);
            chip::Platform::Delete(ctx);
            return CHIP_ERROR_INVALID_ARGUMENT;
        }
        ctx->datasetLen = bytesLen;
    }

    ChipLogProgress(NotSpecified, "[%s] Scheduling PairBleThread node=0x%llX disc=%u", LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId), ctx->discriminator);

    // Hand the job to the Matter thread; DoPairBleThread will run there and free the parcel.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoPairBleThread, reinterpret_cast<intptr_t>(ctx));
}

// Handles "pairing code": pair using the device's full setup code. Validates args,
// copies the code into a parcel, and schedules the real work. Runs on the shell thread.
// matter controller pairing code <node> <MT:.../manual>
static CHIP_ERROR HandlePairingCode(int argc, char * argv[])
{
    // Need exactly a node ID and a setup code.
    VerifyOrReturnError(argc == 2, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: pairing code <node> <setupCode>", LOG_MODULE));

    auto * ctx = chip::Platform::New<PairCodeCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    ctx->nodeId = ParseNodeId(argv[0]);
    // Copy the setup code text into the parcel (bounded, and force a terminating NUL).
    strncpy(ctx->setupCode, argv[1], sizeof(ctx->setupCode) - 1);
    ctx->setupCode[sizeof(ctx->setupCode) - 1] = '\0';

    ChipLogProgress(NotSpecified, "[%s] Scheduling PairCode node=0x%llX", LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId));

    // Hand off to the Matter thread.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoPairCode, reinterpret_cast<intptr_t>(ctx));
}

// Handles "pairing unpair": remove a device from this home's network. Runs on the shell thread.
// matter controller pairing unpair <node>
static CHIP_ERROR HandleUnpair(int argc, char * argv[])
{
    // Need exactly the device ID to forget.
    VerifyOrReturnError(argc == 1, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: pairing unpair <node>", LOG_MODULE));

    auto * ctx = chip::Platform::New<UnpairCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    ctx->nodeId = ParseNodeId(argv[0]);

    ChipLogProgress(NotSpecified, "[%s] Scheduling Unpair node=0x%llX", LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId));

    // Hand off to the Matter thread.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoUnpair, reinterpret_cast<intptr_t>(ctx));
}

// Routes "pairing <something>" to the right handler above based on the first word.
// Runs on the shell thread.
// "pairing" dispatcher
static CHIP_ERROR HandlePairing(int argc, char * argv[])
{
    // Need at least the sub-command word.
    VerifyOrReturnError(argc >= 1, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: pairing <ble-thread|code|unpair> ...", LOG_MODULE));

    // Strip the sub-command word and forward the rest of the arguments.
    if (strcmp(argv[0], "ble-thread") == 0)
    {
        return HandlePairingBleThread(argc - 1, argv + 1);
    }
    if (strcmp(argv[0], "code") == 0)
    {
        return HandlePairingCode(argc - 1, argv + 1);
    }
    if (strcmp(argv[0], "unpair") == 0)
    {
        return HandleUnpair(argc - 1, argv + 1);
    }

    // Unrecognized sub-command.
    ChipLogError(NotSpecified, "[%s] Unknown pairing sub-command: %s", LOG_MODULE, argv[0]);
    return CHIP_ERROR_INVALID_ARGUMENT;
}

// ---------------------------------------------------------------------------
// Shell handler: invoke-cmd
// matter controller invoke-cmd <node> <ep> <cluster> <cmd> [level]
// Supported: OnOff (cluster 0x0006, cmds 0x00/0x01/0x02)
//            LevelControl (cluster 0x0008, cmd 0x00, arg: level)
// ---------------------------------------------------------------------------

// Handles "invoke-cmd": parse which device/endpoint/cluster/command (and optional
// brightness level), package it, and schedule the send on the Matter thread. Runs on
// the shell thread.
static CHIP_ERROR HandleInvokeCmd(int argc, char * argv[])
{
    // Need at least node, endpoint, cluster, command; the level is optional.
    VerifyOrReturnError(argc >= 4, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: invoke-cmd <node> <ep> <cluster> <cmd> [level]", LOG_MODULE));

    auto * ctx = chip::Platform::New<InvokeCmdCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    // Pull each piece out of the typed arguments.
    ctx->nodeId    = ParseNodeId(argv[0]);
    ctx->endpointId = static_cast<chip::EndpointId>(ParseU32(argv[1]));
    ctx->clusterId  = static_cast<chip::ClusterId>(ParseU32(argv[2]));
    ctx->commandId  = static_cast<chip::CommandId>(ParseU32(argv[3]));
    // Optional 5th argument is the brightness level; default 0 if omitted.
    ctx->level      = (argc >= 5) ? ParseU8(argv[4]) : 0;

    ChipLogProgress(NotSpecified, "[%s] Scheduling invoke-cmd node=0x%llX ep=%u cluster=0x%04X cmd=0x%02X",
                    LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId),
                    ctx->endpointId, ctx->clusterId, ctx->commandId);

    // Hand off to the Matter thread.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoInvokeCmd, reinterpret_cast<intptr_t>(ctx));
}

// ---------------------------------------------------------------------------
// Shell handler: read-attr
// matter controller read-attr <node> <ep> <cluster> <attr>
// ---------------------------------------------------------------------------

// Handles "read-attr": parse which setting to read, package it, and schedule the read
// on the Matter thread. Runs on the shell thread.
static CHIP_ERROR HandleReadAttr(int argc, char * argv[])
{
    // Need exactly node, endpoint, cluster, attribute.
    VerifyOrReturnError(argc == 4, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: read-attr <node> <ep> <cluster> <attr>", LOG_MODULE));

    auto * ctx = chip::Platform::New<ReadAttrCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    // Pull each piece out of the typed arguments.
    ctx->nodeId      = ParseNodeId(argv[0]);
    ctx->endpointId  = static_cast<chip::EndpointId>(ParseU32(argv[1]));
    ctx->clusterId   = static_cast<chip::ClusterId>(ParseU32(argv[2]));
    ctx->attributeId = static_cast<chip::AttributeId>(ParseU32(argv[3]));

    ChipLogProgress(NotSpecified, "[%s] Scheduling read-attr node=0x%llX ep=%u cluster=0x%04X attr=0x%04X",
                    LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId),
                    ctx->endpointId, ctx->clusterId, ctx->attributeId);

    // Hand off to the Matter thread.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoReadAttr, reinterpret_cast<intptr_t>(ctx));
}

// ---------------------------------------------------------------------------
// Shell handler: write-attr
// matter controller write-attr <node> <ep> <cluster> <attr> <val>
// ---------------------------------------------------------------------------

// Handles "write-attr": parse which setting to change and to what value, package it,
// and schedule the write on the Matter thread. Runs on the shell thread.
static CHIP_ERROR HandleWriteAttr(int argc, char * argv[])
{
    // Need exactly node, endpoint, cluster, attribute, value.
    VerifyOrReturnError(argc == 5, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: write-attr <node> <ep> <cluster> <attr> <val>", LOG_MODULE));

    auto * ctx = chip::Platform::New<WriteAttrCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    // Pull each piece out of the typed arguments, including the new value.
    ctx->nodeId      = ParseNodeId(argv[0]);
    ctx->endpointId  = static_cast<chip::EndpointId>(ParseU32(argv[1]));
    ctx->clusterId   = static_cast<chip::ClusterId>(ParseU32(argv[2]));
    ctx->attributeId = static_cast<chip::AttributeId>(ParseU32(argv[3]));
    ctx->value       = ParseU32(argv[4]);

    ChipLogProgress(NotSpecified, "[%s] Scheduling write-attr node=0x%llX ep=%u cluster=0x%04X attr=0x%04X val=%u",
                    LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId),
                    ctx->endpointId, ctx->clusterId, ctx->attributeId, ctx->value);

    // Hand off to the Matter thread.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoWriteAttr, reinterpret_cast<intptr_t>(ctx));
}

// ---------------------------------------------------------------------------
// Shell handler: subs-attr
// matter controller subs-attr <node> <ep> <cluster> <attr> <min> <max>
// ---------------------------------------------------------------------------

// Handles "subs-attr": parse which setting to watch and the min/max reporting
// intervals, package it, and schedule the subscription on the Matter thread. Runs on
// the shell thread.
static CHIP_ERROR HandleSubsAttr(int argc, char * argv[])
{
    // Need exactly node, endpoint, cluster, attribute, min interval, max interval.
    VerifyOrReturnError(argc == 6, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified, "[%s] Usage: subs-attr <node> <ep> <cluster> <attr> <min> <max>", LOG_MODULE));

    auto * ctx = chip::Platform::New<SubsAttrCtx>();
    VerifyOrReturnError(ctx != nullptr, CHIP_ERROR_NO_MEMORY);

    // Pull each piece out of the typed arguments, including the reporting interval bounds.
    ctx->nodeId         = ParseNodeId(argv[0]);
    ctx->endpointId     = static_cast<chip::EndpointId>(ParseU32(argv[1]));
    ctx->clusterId      = static_cast<chip::ClusterId>(ParseU32(argv[2]));
    ctx->attributeId    = static_cast<chip::AttributeId>(ParseU32(argv[3]));
    ctx->minIntervalSec = ParseU16(argv[4]);
    ctx->maxIntervalSec = ParseU16(argv[5]);

    ChipLogProgress(NotSpecified,
                    "[%s] Scheduling subs-attr node=0x%llX ep=%u cluster=0x%04X attr=0x%04X min=%u max=%u",
                    LOG_MODULE,
                    static_cast<unsigned long long>(ctx->nodeId),
                    ctx->endpointId, ctx->clusterId, ctx->attributeId,
                    ctx->minIntervalSec, ctx->maxIntervalSec);

    // Hand off to the Matter thread.
    return chip::DeviceLayer::PlatformMgr().ScheduleWork(DoSubsAttr, reinterpret_cast<intptr_t>(ctx));
}

// ---------------------------------------------------------------------------
// "controller" top-level dispatcher
// ---------------------------------------------------------------------------

// Top-level "controller" command: routes to the right sub-handler based on the first
// word the person typed. This is the entry point the shell calls. Runs on the shell thread.
static CHIP_ERROR HandleController(int argc, char * argv[])
{
    // Need at least a sub-command word; otherwise print the list of options.
    VerifyOrReturnError(argc >= 1, CHIP_ERROR_INVALID_ARGUMENT,
                        ChipLogError(NotSpecified,
                                     "[%s] Usage: controller <pairing|invoke-cmd|read-attr|write-attr|subs-attr>",
                                     LOG_MODULE));

    // Match the first word and forward the remaining arguments to that handler.
    if (strcmp(argv[0], "pairing") == 0)    return HandlePairing(argc - 1, argv + 1);
    if (strcmp(argv[0], "invoke-cmd") == 0) return HandleInvokeCmd(argc - 1, argv + 1);
    if (strcmp(argv[0], "read-attr") == 0)  return HandleReadAttr(argc - 1, argv + 1);
    if (strcmp(argv[0], "write-attr") == 0) return HandleWriteAttr(argc - 1, argv + 1);
    if (strcmp(argv[0], "subs-attr") == 0)  return HandleSubsAttr(argc - 1, argv + 1);

    // Unrecognized sub-command.
    ChipLogError(NotSpecified, "[%s] Unknown controller sub-command: %s", LOG_MODULE, argv[0]);
    return CHIP_ERROR_INVALID_ARGUMENT;
}

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

// Registers the "controller" command with the shell so a person can type it at the
// serial prompt. Called once at startup. After this runs, "matter controller ..."
// commands become available.
void RegisterShellCommands()
{
    // Describe the command: the function to run (HandleController), the word that
    // triggers it ("controller"), and the help text shown in the shell. Marked static
    // so this description outlives this function (the shell keeps a pointer to it).
    static chip::Shell::Command sControllerCommand{
        &HandleController,
        "controller",
        "On-device Matter commissioner. Sub-commands: pairing, invoke-cmd, read-attr, write-attr, subs-attr"
    };

    // Hand that one command to the shell's command registry.
    chip::Shell::Engine::Root().RegisterCommands(&sControllerCommand, 1);

    ChipLogProgress(NotSpecified, "[%s] Registered 'controller' shell command", LOG_MODULE);
}

} // namespace controller
} // namespace nrf
