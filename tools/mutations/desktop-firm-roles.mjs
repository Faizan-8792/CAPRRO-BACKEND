// Mutations for the DESKTOP side of the firm role ladder and invitations.
//
//   node tools/mutation-harness.mjs tools/mutations/desktop-firm-roles.mjs
//
// Scored against the whole CaPro.Desktop.Core suite rather than a filtered subset, so a CAUGHT
// here means "the suite catches it" and not "the tests I happened to write catch it". Slower, and
// the stronger claim.
//
// The desktop is a presentation filter -- the server re-checks every call -- so none of these can
// grant access on its own. They matter because the visible symptom of getting one wrong is a
// control that looks live and then fails, or a number that is quietly wrong on a screen a
// chartered accountant is reading. Both are defects this project treats as its own.
//
// Mutation 1 is the one worth naming: it is the exact client-side twin of the disaster
// TASK-MANAGEMENT-DESIGN.md section 2.3 describes, and it was the real state of the code before
// VIEWER was added to the parser.

const dotnet = `${process.env.LOCALAPPDATA}\\Microsoft\\dotnet\\dotnet.exe`;

export const command = [
  dotnet,
  "test",
  "tests/CaPro.Desktop.Core.Tests/CaPro.Desktop.Core.Tests.csproj",
  "-c",
  "Release",
  "--nologo",
];
export const cwd = "../apps/desktop-native";

const IDENTITY = "../apps/desktop-native/src/CaPro.Desktop.Core/Models/Identity.cs";
const CAPABILITY = "../apps/desktop-native/src/CaPro.Desktop.Core/Access/Capability.cs";
const MAPPER = "../apps/desktop-native/src/CaPro.Desktop.Core/Api/ResponseMapper.cs";
const MODEL = "../apps/desktop-native/src/CaPro.Desktop.Core/Models/FirmInvite.cs";
const POLICY = "../apps/desktop-native/src/CaPro.Desktop.Core/Presentation/FirmInvitePolicy.cs";

export const mutations = [
  {
    name: "1. a server-sent VIEWER falls through to Member (the pre-fix state)",
    target: IDENTITY,
    find: `        "VIEWER" => WorkspaceRole.Viewer,\n`,
    replace: "",
  },
  {
    name: "2. Viewer is moved to ladder order, reinterpreting every cached Member",
    target: IDENTITY,
    find: `public enum WorkspaceRole
{
    Member,
    Admin,
    Owner,`,
    replace: `public enum WorkspaceRole
{
    Viewer2,
    Member,
    Admin,
    Owner,`,
  },
  {
    name: "3. the write gate becomes a blacklist, so the next restricted tier may write",
    target: CAPABILITY,
    find: `        return user.Role == UserRole.SuperAdmin
               || workspace.Role is WorkspaceRole.Owner or WorkspaceRole.Admin
               || workspace.Role == WorkspaceRole.Member
                  && workspace.MemberAccess == WorkspaceMemberAccess.Edit;`,
    replace: `        return user.Role == UserRole.SuperAdmin
               || workspace.Role is WorkspaceRole.Owner or WorkspaceRole.Admin
               || workspace.Role != WorkspaceRole.Viewer
                  && workspace.MemberAccess == WorkspaceMemberAccess.Edit;`,
  },
  {
    name: "4. a viewer is granted writes outright",
    target: CAPABILITY,
    find: `               || workspace.Role == WorkspaceRole.Member
                  && workspace.MemberAccess == WorkspaceMemberAccess.Edit;`,
    replace: `               || workspace.Role is WorkspaceRole.Member or WorkspaceRole.Viewer
                  && workspace.MemberAccess == WorkspaceMemberAccess.Edit;`,
  },
  {
    name: "5. the firm-wide read-only switch stops applying to a member",
    target: CAPABILITY,
    find: `               || workspace.Role == WorkspaceRole.Member
                  && workspace.MemberAccess == WorkspaceMemberAccess.Edit;`,
    replace: `               || workspace.Role == WorkspaceRole.Member;`,
  },
  {
    name: "6. an absent memberAccess is read as a grant instead of failing closed",
    target: CAPABILITY,
    find: `                  && workspace.MemberAccess == WorkspaceMemberAccess.Edit;`,
    replace: `                  && workspace.MemberAccess != WorkspaceMemberAccess.ReadOnly;`,
  },
  {
    name: "7. a viewer is granted firm administration",
    target: CAPABILITY,
    find: `        return user.Role == UserRole.SuperAdmin
               || workspace.Role is WorkspaceRole.Owner or WorkspaceRole.Admin;
    }`,
    replace: `        return user.Role == UserRole.SuperAdmin
               || workspace.Role is WorkspaceRole.Owner or WorkspaceRole.Admin or WorkspaceRole.Viewer;
    }`,
  },
  {
    name: "8. the section 1.3(c) asymmetry is put back (FIRM_ADMIN manages with no workspace)",
    target: CAPABILITY,
    find: `            Capability.ManageFirmMembers or Capability.ManageFirmSettings =>
                CanAdministerFirmData(user, workspace),`,
    replace: `            Capability.ManageFirmMembers or Capability.ManageFirmSettings =>
                user.Role is UserRole.FirmAdmin or UserRole.SuperAdmin
                || workspace?.Role is WorkspaceRole.Owner or WorkspaceRole.Admin,`,
  },
  {
    name: "9. an unknown invite status defaults to LIVE",
    target: MAPPER,
    find: `            _ => FirmInviteStatus.Unknown,
        };`,
    replace: `            _ => FirmInviteStatus.Live,
        };`,
  },
  {
    name: "10. an absent usage cap is coalesced to zero",
    target: MAPPER,
    find: `            MaxUses = JsonReader.Int(entry, "maxUses"),`,
    replace: `            MaxUses = JsonReader.Int(entry, "maxUses") ?? 0,`,
  },
  {
    name: "11. an absent remaining count is coalesced to zero",
    target: MAPPER,
    find: `            RemainingUses = JsonReader.Int(entry, "remainingUses"),`,
    replace: `            RemainingUses = JsonReader.Int(entry, "remainingUses") ?? 0,`,
  },
  {
    name: "12. a share link is invented when the server gave none",
    target: MAPPER,
    find: `            ShareUrl = JsonReader.String(entry, "shareUrl"),`,
    replace: `            ShareUrl = JsonReader.String(entry, "shareUrl")
                ?? $"https://caprotoolkit.in/join?code={code}",`,
  },
  {
    name: "13. an absent canJoin is read as permission",
    target: MAPPER,
    find: `            CanJoin = JsonReader.Bool(container, "canJoin") ?? false,`,
    replace: `            CanJoin = JsonReader.Bool(container, "canJoin") ?? true,`,
  },
  {
    name: "14. an ADMIN ceiling is reported as needing no approval",
    target: MAPPER,
    find: `            RequiresApproval = JsonReader.Bool(container, "requiresApproval") ?? false,`,
    replace: `            RequiresApproval = false,`,
  },
  {
    name: "15. a row with no code is kept and rendered as unusable",
    target: MAPPER,
    find: `        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(code))
        {
            return null;
        }`,
    replace: `        if (string.IsNullOrWhiteSpace(id))
        {
            return null;
        }`,
  },
  {
    name: "16. a pending queue row missing an id is kept, offering an impossible decision",
    target: MAPPER,
    find: `                if (string.IsNullOrWhiteSpace(inviteId) || string.IsNullOrWhiteSpace(userId))
                {
                    continue;
                }`,
    replace: `                if (false)
                {
                    continue;
                }`,
  },
  {
    name: "17. usability becomes not-revoked instead of explicitly LIVE",
    target: MODEL,
    find: `    public bool IsUsable => Status == FirmInviteStatus.Live;`,
    replace: `    public bool IsUsable => Status != FirmInviteStatus.Revoked;`,
  },
  {
    name: "18. an invite code is allowed to exceed what shipped clients accept",
    target: MODEL,
    find: `    public static bool IsCodeAcceptable(string? code) =>
        FirmSettingsVocabulary.IsJoinCodeAcceptable(code);`,
    replace: `    public static bool IsCodeAcceptable(string? code) =>
        !string.IsNullOrWhiteSpace(code);`,
  },
  {
    name: "19. an invite may grant OWNER",
    target: MODEL,
    find: `    public static readonly IReadOnlyList<string> GrantableRoles = ["ADMIN", "MEMBER", "VIEWER"];`,
    replace: `    public static readonly IReadOnlyList<string> GrantableRoles = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];`,
  },
  {
    name: "20. the default ceiling becomes the top grantable tier",
    target: MODEL,
    find: `    public const string DefaultGrantableRole = "MEMBER";`,
    replace: `    public const string DefaultGrantableRole = "ADMIN";`,
  },

  // --- the copy, which is where an overstatement would actually reach somebody ---
  {
    name: "21. an unrecognised designation collapses to Member",
    target: POLICY,
    find: `            _ => role!.Trim(),`,
    replace: `            _ => "Member",`,
  },
  {
    name: "22. an unrecognised invite status reads as Live",
    target: POLICY,
    find: `            _ => invite.StatusRaw is { Length: > 0 } raw
                ? $"Reported as {raw}"
                : "State not recorded",`,
    replace: `            _ => "Live",`,
  },
  {
    name: "23. an uncapped invitation reports zero uses left",
    target: POLICY,
    find: `        if (invite.MaxUses is not { } cap)
        {
            return $"{used}, no limit";
        }`,
    replace: `        var cap = invite.MaxUses ?? 0;`,
  },
  {
    name: "24. a remaining count is allowed to go negative",
    target: POLICY,
    find: `        var left = invite.RemainingUses ?? Math.Max(0, cap - invite.UsedCount);`,
    replace: `        var left = invite.RemainingUses ?? (cap - invite.UsedCount);`,
  },
  {
    name: "25. the pending line shouts zero on every ordinary invitation",
    target: POLICY,
    find: `            <= 0 => string.Empty,`,
    replace: `            <= 0 => "0 people are waiting for your approval",`,
  },
  {
    name: "26. a person with no name is given an invented one",
    target: POLICY,
    find: `                : "Name not recorded";

        var joined = acceptance.AcceptedUtc is { } when`,
    replace: `                : $"User {acceptance.UserId}";

        var joined = acceptance.AcceptedUtc is { } when`,
  },
  {
    name: "27. a truncated list reports its returned count as the total",
    target: POLICY,
    find: `        var count = SurfaceFormat.Count(directory.Invites.Count, directory.Truncated);`,
    replace: `        var count = SurfaceFormat.Count(directory.Invites.Count, false);`,
  },
  {
    name: "28. the withdrawal warning stops saying it cannot be undone",
    target: POLICY,
    find: `        "Withdrawing an invitation cannot be undone. Anyone holding the code will no longer be able to use it, and people who have already joined are not affected.";`,
    replace: `        "Turn this invitation off. You can turn it back on later.";`,
  },
  {
    name: "29. the admin-ceiling notice claims the designation takes effect on joining",
    target: POLICY,
    find: `        "Someone joining with this code becomes a member first. You approve the administrator designation yourself, from Requests, before it takes effect.";`,
    replace: `        "Someone joining with this code becomes an administrator of this workspace.";`,
  },
  {
    name: "30. the approval confirmation drops the bound on what is granted",
    target: POLICY,
    find: `        return $"{who} will be able to administer this workspace's data, its members and its invitations. "
            + "They will not be able to transfer ownership, change another administrator, or approve a designation. "
            + "This applies to this workspace only.";`,
    replace: `        return $"{who} will be able to administer this workspace.";`,
  },
  {
    name: "31. the decline confirmation reads as a removal",
    target: POLICY,
    find: `        "The request is declined and they keep the designation they have now. They remain a member of this workspace.";`,
    replace: `        "The request is declined.";`,
  },
  {
    name: "32. a refused read is offered a retry that cannot work",
    target: POLICY,
    find: `            emptyTitle: "No invitations yet",`,
    replace: `            emptyTitle: "No invitations",`,
  },
];
