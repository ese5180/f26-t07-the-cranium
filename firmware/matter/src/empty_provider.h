/*
 * empty_provider.h — a DataModel::Provider that serves no endpoints/clusters.
 *
 * A Matter commissioner is a pure *client*: it drives commissioning and then
 * reads/writes/invokes on the commissioned node via ReadClient / CommandSender.
 * It does not host any clusters of its own (enableServerInteractions = false),
 * so the InteractionModelEngine only needs a non-null provider whose
 * server-facing surface is empty.
 *
 * Using this instead of the codegen/ember provider avoids dragging in the full
 * Server::Init() bring-up (AccessControl, EventManagement, and every server
 * cluster's Startup()), which a controller-only image deliberately skips and
 * which otherwise aborts during InteractionModelEngine init.
 *
 * Mirrors connectedhomeip's testing EmptyProvider, re-homed into this project's
 * namespace so we don't depend on test-only code being compiled into the SDK.
 *
 * In plain English:
 * The Matter engine expects the local device to describe the "gadgets" it hosts
 * — its endpoints (logical sub-devices) and clusters (groups of on/off, brightness,
 * color, etc. commands and settings) — so other devices could read and control it.
 * But this firmware is a hub: it only ADDS and CONTROLS other smart devices; it is
 * never a light bulb or switch itself, so it hosts nothing. Yet the Matter engine
 * still refuses to start unless it is handed SOME description object. This file is
 * that placeholder: a "provider" (the thing that answers "what do you host?") that
 * truthfully answers "nothing." Every method returns empty lists or "not supported."
 * Using this tiny stub lets us skip the heavy full-device startup machinery (which
 * a hub-only build deliberately leaves out and which would otherwise crash on boot).
 */

#pragma once

#include <app/data-model-provider/Provider.h>
#include <protocols/interaction_model/StatusCode.h>

// This project's own namespaces (nrf::controller) so these names don't collide
// with the SDK's or anyone else's.
namespace nrf {
namespace controller {

// The stub itself. It "is a" Provider (inherits the Matter engine's provider
// interface) but every answer it gives means "I host nothing to offer."
class EmptyDataModelProvider : public chip::app::DataModel::Provider
{
public:
    // A short local nickname for the SDK's "how did this operation turn out?"
    // status type, so the method signatures below read a little more cleanly.
    using ActionReturnStatus = chip::app::DataModel::ActionReturnStatus;

    // ---- ProviderMetadataTree (metadata; all empty/unsupported) ----
    // The methods in this group answer "what does this device contain?" questions.
    // Since the hub contains no hosted device parts, each returns an empty list
    // (or "not supported"). The empty list is the whole point of this file.
    // "List the logical sub-devices I host." We host none, so returns an empty list.
    CHIP_ERROR Endpoints(chip::ReadOnlyBufferBuilder<chip::app::DataModel::EndpointEntry> & builder) override;
    // "For a given sub-device, what kind of device is it (light, sensor, ...)?"
    // We have no sub-devices, so this returns nothing.
    CHIP_ERROR DeviceTypes(chip::EndpointId endpointId,
                           chip::ReadOnlyBufferBuilder<chip::app::DataModel::DeviceTypeEntry> & builder) override;
    // "Which client-role clusters does THIS sub-device declare on itself?"
    // (A client-role cluster is a metadata note that an endpoint intends to talk to a
    // matching server cluster elsewhere — a declared binding, NOT the actual act of
    // controlling another device.) The hub declares none, so this returns an empty list.
    // Note this is only the local metadata declaration; the hub's real outbound control
    // of other devices happens through entirely separate client code, not this list.
    CHIP_ERROR ClientClusters(chip::EndpointId endpointId,
                              chip::ReadOnlyBufferBuilder<chip::ClusterId> & builder) override;
    // "Which clusters does this sub-device OFFER as a SERVER (that others can control)?"
    // The hub offers none, so empty — this is the key "I host nothing" answer.
    CHIP_ERROR ServerClusters(chip::EndpointId endpointId,
                              chip::ReadOnlyBufferBuilder<chip::app::DataModel::ServerClusterEntry> & builder) override;
#if CHIP_CONFIG_USE_ENDPOINT_UNIQUE_ID
    // (Only compiled if the SDK is configured to use unique endpoint IDs.)
    // "Give me this sub-device's unique ID." None exist, so nothing to give.
    CHIP_ERROR EndpointUniqueID(chip::EndpointId endpointId, chip::MutableCharSpan & epUniqueId) override;
#endif
    // "Describe a specific event this device can emit." We emit none — unsupported.
    CHIP_ERROR EventInfo(const chip::app::ConcreteEventPath & path,
                         chip::app::DataModel::EventEntry & eventInfo) override;
    // "List the attributes (readable/writable settings) in a given cluster." None here.
    CHIP_ERROR Attributes(const chip::app::ConcreteClusterPath & path,
                          chip::ReadOnlyBufferBuilder<chip::app::DataModel::AttributeEntry> & builder) override;
    // "List the commands a given cluster can send back out." None here.
    CHIP_ERROR GeneratedCommands(const chip::app::ConcreteClusterPath & path,
                                 chip::ReadOnlyBufferBuilder<chip::CommandId> & builder) override;
    // "List the commands a given cluster will accept from others." None here.
    CHIP_ERROR AcceptedCommands(const chip::app::ConcreteClusterPath & path,
                                chip::ReadOnlyBufferBuilder<chip::app::DataModel::AcceptedCommandEntry> & builder) override;

    // Called when someone writes to a list-type attribute we host. We host none,
    // so this notification is a no-op (empty body: do nothing).
    void ListAttributeWriteNotification(const chip::app::ConcreteAttributePath & aPath,
                                        chip::app::DataModel::ListWriteOperation opType,
                                        chip::FabricIndex accessingFabric) override
    {}
    // Called to announce one of our attributes changed value (so it can be reported
    // to subscribers). Nothing here ever changes, so this does nothing.
    void Temporary_ReportAttributeChanged(const chip::app::AttributePathParams & path) override {}

    // ---- Provider (operations; all unsupported) ----
    // The methods below are the actual "do something to a hosted attribute/command"
    // requests. Because the hub hosts nothing, each one refuses with an error status.

    // Someone tried to READ one of our attributes. We have none, so this reports failure.
    ActionReturnStatus ReadAttribute(const chip::app::DataModel::ReadAttributeRequest & request,
                                     chip::app::AttributeValueEncoder & encoder) override;
    // Someone tried to WRITE one of our attributes. We have none, so this reports failure.
    ActionReturnStatus WriteAttribute(const chip::app::DataModel::WriteAttributeRequest & request,
                                      chip::app::AttributeValueDecoder & decoder) override;
    // Someone tried to INVOKE a command on us. We accept none, so this reports failure.
    std::optional<ActionReturnStatus> InvokeCommand(const chip::app::DataModel::InvokeRequest & request,
                                                    chip::TLV::TLVReader & input_arguments,
                                                    chip::app::CommandHandler * handler) override;
};

} // namespace controller
} // namespace nrf
