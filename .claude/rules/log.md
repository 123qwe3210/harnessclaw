# Rules that need to follow when introducing new features
# Rule 1
## Design failure paths before developing the feature 
Before implementation, every feature must explicitly define:
-  success 
-  failure 
-  timeout 
-  retry 
-  cancellation 

# Rule 2
## Cross-boundary calls must be logged in pairs
At minimum, every cross-boundary call must include:
- started
- ok / error
When needed, also include:
- retrying
- timeout
- cancelled


# Rule 3
## Every feature must have a clear domain
Logs must not be dumped into generic domains such as ui, misc, or console.


# Rule 4
## Every request must be traceable
Use the following identifiers consistently:
- runId
- requestId
- sessionId (for chat-related flows) 
Any log without correlation IDs is considered incomplete.


# Rule 5
## Failure logs must include “cause + context + guidance”
Failure logs must be directly actionable for troubleshooting.


# Rule 6
## Log only milestones for success, not noisy flow details
This prevents log bloat and keeps important signals visible.


# Rule 7
## Mask sensitive data by default; higher verbosity must require an explicit switch
Debug-level details may only be enabled in support or debug mode.


# Rule 8
## New features must be integrated into logging in three places
Every new feature must include all of the following before release:
-  runtime logs 
-  structured diagnostic events 
-  log viewer summary mapping 
Missing any one of these means the logging integration is incomplete.