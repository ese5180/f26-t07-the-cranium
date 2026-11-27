#include <gtest/gtest.h>

#include <memory>
#include <type_traits>

#include "library/rekordbox/rekordboxsessionstate.h"
#include "track/sourcebinding.h"
#include "track/track.h"
#include "track/trackusepolicy.h"

namespace {

TEST(TrackCapabilityPolicyTest, FixedProfilesCannotBeElevatedOrAssigned) {
    static_assert(std::is_copy_constructible_v<mixxx::TrackUsePolicy>);
    static_assert(!std::is_copy_assignable_v<mixxx::TrackUsePolicy>);
    static_assert(!std::is_default_constructible_v<mixxx::TrackUsePolicy>);

    constexpr auto usb = mixxx::TrackUsePolicy::rekordboxUsbPolicy();
    EXPECT_FALSE(usb.canPersist());
    EXPECT_FALSE(usb.canImport());
    EXPECT_FALSE(usb.canAnalyze());
    EXPECT_FALSE(usb.canExportMetadata());
    EXPECT_TRUE(usb.canLoadForPlayback());

    constexpr auto standard = mixxx::TrackUsePolicy::standardLibraryPolicy();
    EXPECT_TRUE(standard.canPersist());
    EXPECT_TRUE(standard.canImport());
    EXPECT_TRUE(standard.canAnalyze());
    EXPECT_TRUE(standard.canExportMetadata());
    EXPECT_TRUE(standard.canLoadForPlayback());
}

TEST(TrackCapabilityPolicyTest, CopyPreservesPolicy) {
    constexpr auto original = mixxx::TrackUsePolicy::rekordboxUsbPolicy();
    constexpr auto copy = original;
    static_assert(copy == original);
    EXPECT_EQ(copy, original);
}

TEST(TrackCapabilityPolicyTest, SessionIdentifiersAreUniqueAndMonotonic) {
    const auto first = mixxx::rekordbox::SessionIdentifier::create();
    const auto second = mixxx::rekordbox::SessionIdentifier::create();

    ASSERT_TRUE(first.isValid());
    ASSERT_TRUE(second.isValid());
    EXPECT_LT(first.generation(), second.generation());
    EXPECT_NE(first.uuid(), second.uuid());
    EXPECT_NE(first, second);
}

TEST(TrackCapabilityPolicyTest, RevocationAndInvalidationAreTerminal) {
    mixxx::rekordbox::SessionState session;
    ASSERT_TRUE(session.isActive());

    EXPECT_TRUE(session.revoke());
    EXPECT_TRUE(session.isRevoked());
    EXPECT_FALSE(session.isActive());
    EXPECT_FALSE(session.revoke());

    EXPECT_TRUE(session.invalidate());
    EXPECT_TRUE(session.isInvalidated());
    EXPECT_FALSE(session.isRevoked());
    EXPECT_FALSE(session.isActive());
    EXPECT_FALSE(session.revoke());
    EXPECT_FALSE(session.invalidate());
}

TEST(TrackCapabilityPolicyTest, BindingCopyObservesImmediateRevocation) {
    auto session = std::make_shared<mixxx::rekordbox::SessionState>();
    const auto binding = mixxx::SourceBinding::rekordboxUsb(42, session);
    const auto copy = binding;

    ASSERT_TRUE(binding.isValid());
    ASSERT_TRUE(binding.isSessionLive());
    EXPECT_EQ(copy.sourceType(), mixxx::SourceType::RekordboxUsb);
    EXPECT_EQ(copy.rekordboxId(), 42u);
    EXPECT_EQ(copy.sessionIdentifier(), session->identifier());
    ASSERT_TRUE(copy.isSessionLive());

    EXPECT_TRUE(session->revoke());
    EXPECT_FALSE(binding.isSessionLive());
    EXPECT_FALSE(copy.isSessionLive());
}

TEST(TrackCapabilityPolicyTest, BindingFailsClosedWhenSessionExpires) {
    std::weak_ptr<const mixxx::rekordbox::SessionState> observer;
    const auto binding = [&observer]() {
        auto session = std::make_shared<mixxx::rekordbox::SessionState>();
        observer = session;
        auto value = mixxx::SourceBinding::rekordboxUsb(7, session);
        EXPECT_TRUE(value.isSessionLive());
        return value;
    }();

    EXPECT_TRUE(observer.expired());
    EXPECT_TRUE(binding.isValid());
    EXPECT_FALSE(binding.isSessionLive());
}

TEST(TrackCapabilityPolicyTest, MissingOrInvalidatedSessionIsNotLive) {
    const auto missing = mixxx::SourceBinding::rekordboxUsb(9, nullptr);
    EXPECT_FALSE(missing.isValid());
    EXPECT_FALSE(missing.isSessionLive());

    auto session = std::make_shared<mixxx::rekordbox::SessionState>();
    const auto invalidated = mixxx::SourceBinding::rekordboxUsb(9, session);
    ASSERT_TRUE(invalidated.isSessionLive());
    EXPECT_TRUE(session->invalidate());
    EXPECT_FALSE(invalidated.isSessionLive());

    const auto standard = mixxx::SourceBinding::standardLibrary();
    EXPECT_TRUE(standard.isValid());
    EXPECT_FALSE(standard.isSessionLive());
}

TEST(TrackCapabilityPolicyTest, StandardTemporaryTrackKeepsStandardContext) {
    const auto track = Track::newTemporary();
    ASSERT_TRUE(track);
    EXPECT_EQ(track->getUsePolicy(),
            mixxx::TrackUsePolicy::standardLibraryPolicy());
    EXPECT_EQ(track->getSourceBinding().sourceType(),
            mixxx::SourceType::StandardLibrary);
    EXPECT_TRUE(track->getSourceBinding().isValid());
}

TEST(TrackCapabilityPolicyTest, RekordboxTemporaryTrackKeepsBindingAndRevocation) {
    auto session = std::make_shared<mixxx::rekordbox::SessionState>();
    const auto binding = mixxx::SourceBinding::rekordboxUsb(123, session);
    const auto track = Track::newTemporary(
            mixxx::FileAccess(),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),
            binding);

    ASSERT_TRUE(track);
    EXPECT_EQ(track->getUsePolicy(),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy());
    EXPECT_EQ(track->getSourceBinding().rekordboxId(), 123u);
    EXPECT_TRUE(track->getSourceBinding().isSessionLive());
    EXPECT_TRUE(track->isSourceAvailableForPlayback());

    mixxx::TrackRecord replacement;
    replacement.refMetadata().refTrackInfo().setTitle(QStringLiteral("replacement"));
    EXPECT_TRUE(track->replaceRecord(std::move(replacement), nullptr));
    EXPECT_EQ(track->getUsePolicy(),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy());
    EXPECT_EQ(track->getSourceBinding().rekordboxId(), 123u);

    EXPECT_TRUE(session->revoke());
    EXPECT_FALSE(track->getSourceBinding().isSessionLive());
    EXPECT_FALSE(track->isSourceAvailableForPlayback());
}

TEST(TrackCapabilityPolicyTest, TemporaryTrackRejectsInconsistentOrDeadContext) {
    auto session = std::make_shared<mixxx::rekordbox::SessionState>();
    const auto usbBinding = mixxx::SourceBinding::rekordboxUsb(10, session);

    EXPECT_FALSE(Track::newTemporary(
            mixxx::FileAccess(),
            mixxx::TrackUsePolicy::standardLibraryPolicy(),
            usbBinding));
    EXPECT_FALSE(Track::newTemporary(
            mixxx::FileAccess(),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),
            mixxx::SourceBinding::standardLibrary()));

    ASSERT_TRUE(session->revoke());
    EXPECT_FALSE(Track::newTemporary(
            mixxx::FileAccess(),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),
            usbBinding));
}

} // namespace
