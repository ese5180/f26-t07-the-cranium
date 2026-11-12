/*
 * empty_provider.cpp — see empty_provider.h.
 *
 * Every metadata query reports "no such endpoint"; every operation reports
 * UnsupportedEndpoint. The commissioner never serves inbound cluster traffic,
 * so these paths are not exercised in normal operation — they exist only to
 * satisfy the InteractionModelEngine's requirement for a non-null provider.
 *
 * In plain English:
 * Matter (the shared smart-home language) expects every device to describe the
 * "features it offers" — its endpoints (logical sub-devices, e.g. "the light")
 * and clusters (groups of related commands, e.g. on/off or brightness) — and to
 * answer when someone tries to read or control those features. But THIS chip is
 * only the hub (the commissioner/controller): its job is to add and control
 * OTHER smart devices, not to be controlled itself. So it offers nothing of its
 * own. The Matter engine still refuses to start unless it is handed some object
 * to answer those "what features do you have?" questions, so this file provides
 * a deliberately empty stand-in: it always answers "I have no such feature" or
 * "that's not supported." It exists purely to keep the build valid and the
 * engine happy; in normal use none of these functions actually get called.
 */

#include "empty_provider.h"

namespace nrf {
namespace controller {

// Short alias for Matter's standard result codes (the numbered "how did it go?"
// answers, like Success or UnsupportedEndpoint) used throughout this file.
using chip::Protocols::InteractionModel::Status;

// Lists this device's endpoints (its logical sub-devices, like "the light").
// Called when something asks "what parts does this device have?" The hub has
// none of its own, so we fill in nothing and report success (an empty list).
CHIP_ERROR EmptyDataModelProvider::Endpoints(
    chip::ReadOnlyBufferBuilder<chip::app::DataModel::EndpointEntry> & builder)
{
    // No endpoints — return an empty (but successful) list.
    return CHIP_NO_ERROR;
}

// Reports what "kind" of device a given endpoint is (e.g. a dimmable light).
// Since the hub exposes no endpoints, any endpoint asked about is unknown, so
// we answer "no such endpoint."
CHIP_ERROR EmptyDataModelProvider::DeviceTypes(
    chip::EndpointId, chip::ReadOnlyBufferBuilder<chip::app::DataModel::DeviceTypeEntry> &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Lists the "client" clusters on an endpoint — the feature groups this device
// would use to control OTHERS. We expose no endpoints, so: no such endpoint.
CHIP_ERROR EmptyDataModelProvider::ClientClusters(
    chip::EndpointId, chip::ReadOnlyBufferBuilder<chip::ClusterId> &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Lists the "server" clusters on an endpoint — the feature groups this device
// would offer for others to control. We offer none, so: no such endpoint.
CHIP_ERROR EmptyDataModelProvider::ServerClusters(
    chip::EndpointId, chip::ReadOnlyBufferBuilder<chip::app::DataModel::ServerClusterEntry> &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Only compiled if this build enables per-endpoint unique IDs.
#if CHIP_CONFIG_USE_ENDPOINT_UNIQUE_ID
// Returns a stable unique ID string for an endpoint. We have no endpoints, so
// there is nothing to identify: no such endpoint.
CHIP_ERROR EmptyDataModelProvider::EndpointUniqueID(chip::EndpointId, chip::MutableCharSpan &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}
#endif

// Describes an "event" a cluster can emit (a notification like a button press).
// Nothing here emits events, so any event path is unknown: no such endpoint.
CHIP_ERROR EmptyDataModelProvider::EventInfo(const chip::app::ConcreteEventPath &,
                                             chip::app::DataModel::EventEntry &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Lists the attributes (readable/writable values, like brightness level) inside
// a given cluster. We have no clusters, so: no such endpoint.
CHIP_ERROR EmptyDataModelProvider::Attributes(
    const chip::app::ConcreteClusterPath &,
    chip::ReadOnlyBufferBuilder<chip::app::DataModel::AttributeEntry> &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Lists the commands a cluster can produce as responses. None exist here, so:
// no such endpoint.
CHIP_ERROR EmptyDataModelProvider::GeneratedCommands(
    const chip::app::ConcreteClusterPath &, chip::ReadOnlyBufferBuilder<chip::CommandId> &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Lists the commands a cluster is willing to receive (e.g. "turn on"). We offer
// none, so: no such endpoint.
CHIP_ERROR EmptyDataModelProvider::AcceptedCommands(
    const chip::app::ConcreteClusterPath &,
    chip::ReadOnlyBufferBuilder<chip::app::DataModel::AcceptedCommandEntry> &)
{
    return CHIP_IM_GLOBAL_STATUS(UnsupportedEndpoint);
}

// Handles an incoming request to READ one of this device's values. Since this
// device exposes nothing, every read is rejected as unsupported.
EmptyDataModelProvider::ActionReturnStatus EmptyDataModelProvider::ReadAttribute(
    const chip::app::DataModel::ReadAttributeRequest &, chip::app::AttributeValueEncoder &)
{
    return Status::UnsupportedEndpoint;
}

// Handles an incoming request to WRITE (change) one of this device's values.
// Nothing here is writable, so every write is rejected as unsupported.
EmptyDataModelProvider::ActionReturnStatus EmptyDataModelProvider::WriteAttribute(
    const chip::app::DataModel::WriteAttributeRequest &, chip::app::AttributeValueDecoder &)
{
    return Status::UnsupportedEndpoint;
}

// Handles an incoming request to RUN a command on this device (e.g. "turn on").
// This device offers no commands, so every invocation is rejected as
// unsupported.
// About the return value (per the SDK contract): returning an optional here is
// BACKWARDS from what you might guess. std::nullopt (an EMPTY optional) means
// "I handled it myself — the response is already in the CommandHandler." A
// FILLED-IN value (like the UnsupportedEndpoint status below) means "I did NOT
// handle it; caller, please report this status back to the client for me."
// So filling in UnsupportedEndpoint correctly signals "not handled here."
// (The second parameter is a chip::TLV::TLVReader — TLV = Tag-Length-Value,
// Matter's compact binary format for data on the wire — used to read the raw
// bytes of the command's arguments.)
std::optional<EmptyDataModelProvider::ActionReturnStatus> EmptyDataModelProvider::InvokeCommand(
    const chip::app::DataModel::InvokeRequest &, chip::TLV::TLVReader &, chip::app::CommandHandler *)
{
    return Status::UnsupportedEndpoint;
}

} // namespace controller
} // namespace nrf
