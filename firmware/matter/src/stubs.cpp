/*
 * stubs.cpp — link-time stubs for symbols pulled in by the CHIP shell that this
 * controller doesn't actually run.
 *
 * In plain English: When you build a program, every piece of code that gets
 * referenced must actually exist somewhere, or the build fails at the final
 * "linking" step. The shared Matter code (CHIP = the open-source software that
 * implements Matter, the smart-home standard) includes a built-in text command
 * called "ota" (for over-the-air firmware updates). That command asks for a
 * software component we deliberately left out of this hub, because this device is
 * a controller (the hub/brain that adds and controls smart devices), not something
 * that receives updates. This file is a "stand-in": it provides just enough of a
 * placeholder to make the build succeed, while doing nothing real. The unused
 * "ota" command still exists but simply has nothing behind it.
 */

// Brings in the declaration of the OTA (over-the-air update) interface type and
// the GetRequestorInstance() function we are about to provide a placeholder for.
#include <app/clusters/ota-requestor/OTARequestorInterface.h>

namespace chip {

// The shared Matter code calls this function to get a handle to the "firmware
// update receiver" component. Since this hub doesn't include that component, we
// hand back nullptr (a "nothing here" pointer). This exists purely so the program
// links successfully; it is never used at runtime because we never invoke the OTA
// update feature on this device.
OTARequestorInterface * GetRequestorInstance()
{
    return nullptr;
}

} // namespace chip
