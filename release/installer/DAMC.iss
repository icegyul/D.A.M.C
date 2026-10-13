; DAMC — Dalur AI Memory Center
; Windows installer. Builds with Inno Setup 6 (ISCC.exe).
;
; DAMC runs inside Docker Desktop, which is per-user, so this installs per-user
; and never asks for elevation. Docker Desktop itself is a prerequisite and is
; deliberately not bundled: DAMC never ships or installs a Docker binary of its
; own, it only points at the official download page.
;
; Nothing the user launches opens a console. Shortcuts run scripts\damc-launch.vbs
; (wscript, window style 0), and the post-install start runs from [Code] with the
; wizard's status line as the only feedback. damc-start.cmd writes to a log file.
;
; Docker is handled in three cases:
;   A. installed and running          -> install, start DAMC (hidden), open the dashboard
;   B. installed but not running      -> start Docker Desktop, wait for the engine
;                                        (progress on the status line), then as A
;   C. not installed                  -> explain why it is needed, offer the official
;                                        download page, let the user install DAMC now
;                                        and come back
; "Installed" is decided from the Docker Desktop executable or its Uninstall
; registry entry, not from `docker --version`: the CLI being on PATH says nothing
; about whether the engine is up, which is exactly case B.
;
; This file is UTF-8 with BOM (the Korean strings need it).

#define AppName        "DAMC"
#define AppFullName    "DAMC - Dalur AI Memory Center"
#define AppVersion     "1.2.0"
#define AppPublisher   "Dalur"
#define AppURL         "http://127.0.0.1:8787"
#define PayloadDir     "..\payload"
#define DockerURL      "https://www.docker.com/products/docker-desktop/"

[Setup]
AppId={{7C2F0B3E-5A41-4C86-9E13-2E6D8A1F4B90}
AppName={#AppFullName}
AppVersion={#AppVersion}
AppVerName={#AppFullName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\DAMC
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..
OutputBaseFilename=DAMC_Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppFullName}
SetupLogging=yes
CloseApplications=no

[Languages]
Name: "korean";  MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
korean.RunOpen=브라우저에서 DAMC 열기
english.RunOpen=Open DAMC in the browser
korean.DockerStarting=Docker Desktop을 시작하는 중... DAMC는 Docker 안에서 실행됩니다.
english.DockerStarting=Starting Docker Desktop... DAMC runs inside Docker.
korean.DockerWaiting=Docker 엔진이 준비될 때까지 기다리는 중... (%1초) 처음에는 1분 정도 걸릴 수 있습니다.
english.DockerWaiting=Waiting for the Docker engine... (%1 s) The first start can take about a minute.
korean.DamcPreparing=필요한 구성요소를 준비하는 중... 처음 설치에서는 1~2분 걸릴 수 있습니다.
english.DamcPreparing=Preparing the required components... The first install can take a minute or two.
korean.DamcStarting=DAMC를 시작하는 중...
english.DamcStarting=Starting DAMC...
korean.StartFailed=DAMC를 시작하지 못했습니다. (코드 %1)%n%n파일은 설치되었습니다. 시작 메뉴의 "DAMC"로 다시 시도하면 문제가 안내 창으로 표시됩니다.%n%n로그: %2
english.StartFailed=DAMC could not be started. (code %1)%n%nThe files are installed. Try again from the Start Menu ("DAMC"); the problem will be shown in a dialog.%n%nLog: %2
korean.DockerMissingBody=DAMC를 실행하려면 Docker Desktop이 필요합니다.%n%nDAMC는 데이터베이스와 함께 Docker 안에서 실행되므로, Docker Desktop이 없으면 시작할 수 없습니다. 이 PC에서 Docker Desktop을 찾지 못했습니다.%n%n공식 다운로드 페이지를 지금 열까요?%n%1
english.DockerMissingBody=DAMC needs Docker Desktop.%n%nDAMC runs inside Docker together with its database, so it cannot start without Docker Desktop, and none was found on this PC.%n%nOpen the official download page now?%n%1
korean.DockerMissingContinue=Docker Desktop을 나중에 설치할 수도 있습니다.%n%nDAMC를 지금 설치해 두고, Docker Desktop을 설치·실행한 뒤 시작 메뉴의 "DAMC"를 실행하면 됩니다.%n%nDAMC를 지금 설치할까요?
english.DockerMissingContinue=You can install Docker Desktop later.%n%nInstall DAMC now, then after Docker Desktop is installed and running, use "DAMC" from the Start Menu.%n%nInstall DAMC now?
korean.DockerNotReady=Docker Desktop이 아직 준비되지 않았습니다.%n%nDAMC 파일은 설치되었습니다. Docker Desktop 창에 "Engine running"이 표시되면 시작 메뉴의 "DAMC"를 실행하세요. 재부팅이 필요하다고 Docker가 안내하면 재부팅 후 실행하면 됩니다.
english.DockerNotReady=Docker Desktop is not ready yet.%n%nDAMC's files are installed. When the Docker Desktop window shows "Engine running", run "DAMC" from the Start Menu. If Docker asks for a restart, do that first.
korean.UninstallKeepData=DAMC 기억 데이터베이스도 삭제할까요?%n%n"아니요"를 선택하면 모든 기억·프로젝트·대화가 Docker 볼륨 "damc_damc_pg"와 "damc_damc_storage"에 그대로 남고, DAMC를 다시 설치하면 복원됩니다.%n%n"예"를 선택하면 둘 다 삭제됩니다 - 데이터베이스와 보관된 내보내기 파일 모두. 되돌릴 수 없습니다.
english.UninstallKeepData=Also delete your DAMC memory database?%n%nChoosing No keeps every memory, project and conversation in the Docker volumes "damc_damc_pg" and "damc_damc_storage", so reinstalling DAMC restores them.%n%nChoosing Yes deletes both - the database and any kept export archives. This cannot be undone.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\docker-compose.yml"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\README.txt";         DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\scripts\*";          DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#PayloadDir}\images\*";           DestDir: "{app}\images";  Flags: ignoreversion
; AI setup packs (copy-ready MCP configs + shared memory skill per AI).
; Read-only reference files the AI Connections screen points to; no secrets inside.
Source: "..\..\integrations\*";             DestDir: "{app}\integrations"; Flags: ignoreversion recursesubdirs

[Dirs]
Name: "{localappdata}\DAMC\logs"

[Icons]
; Everything a user clicks goes through the hidden launcher. No console window.
Name: "{group}\DAMC";           Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\damc-launch.vbs"" open";  WorkingDir: "{app}"; Comment: "Start DAMC if needed and open the dashboard"
Name: "{group}\Start DAMC";     Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\damc-launch.vbs"" start"; WorkingDir: "{app}"
Name: "{group}\Stop DAMC";      Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\damc-launch.vbs"" stop";  WorkingDir: "{app}"
Name: "{group}\DAMC Status";    Filename: "{app}\scripts\damc-status.cmd"; WorkingDir: "{app}"; Comment: "Diagnostics (opens a console)"
Name: "{group}\DAMC Logs";      Filename: "{localappdata}\DAMC\logs"
Name: "{group}\Uninstall DAMC"; Filename: "{uninstallexe}"
Name: "{autodesktop}\DAMC";     Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\damc-launch.vbs"" open";  WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; The start itself happens in CurStepChanged(ssPostInstall) below, hidden. The one
; offer left on the finish page is the browser, and only if that start succeeded.
Filename: "{#AppURL}"; Description: "{cm:RunOpen}"; Flags: postinstall shellexec nowait skipifsilent; Check: DamcStartedCheck

[UninstallRun]
; Stops and removes the containers. The data volume is kept unless the user
; explicitly asks for it to go (handled in CurUninstallStepChanged below).
Filename: "{cmd}"; Parameters: "/c ""{app}\scripts\damc-uninstall-cleanup.cmd"""; WorkingDir: "{app}"; RunOnceId: "DamcDown"; Flags: runhidden

[Code]
var
  DockerDesktopFound: Boolean;   // executable or Uninstall registry entry present
  DockerReady: Boolean;          // `docker info` answered - the engine is up
  DamcStarted: Boolean;          // the hidden post-install start returned 0

function DamcStartedCheck(): Boolean;
begin
  Result := DamcStarted;
end;

function DockerDesktopExe(): String;
begin
  Result := ExpandConstant('{commonpf}\Docker\Docker\Docker Desktop.exe');
end;

// The engine, not the CLI. `docker --version` succeeds with the engine stopped.
function DockerEngineReady(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/c docker info >nul 2>&1', '',
                 SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function DockerDesktopInstalled(): Boolean;
var
  Name: String;
begin
  Result := FileExists(DockerDesktopExe())
    or RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop', 'DisplayName', Name)
    or RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop', 'DisplayName', Name);
end;

// Case B. Launch Docker Desktop if it is not running and poll the engine,
// reporting elapsed time on the wizard's status line so the wait is visibly
// alive. Returns True as soon as `docker info` answers.
function WaitForDocker(MaxSeconds: Integer): Boolean;
var
  ResultCode, Waited: Integer;
begin
  Result := DockerEngineReady();
  if Result then
    Exit;
  if FileExists(DockerDesktopExe()) then
    ShellExec('', DockerDesktopExe(), '', '', SW_SHOWMINNOACTIVE, ewNoWait, ResultCode);
  Waited := 0;
  while (not Result) and (Waited < MaxSeconds) do
  begin
    WizardForm.StatusLabel.Caption := FmtMessage(CustomMessage('DockerWaiting'), [IntToStr(Waited)]);
    WizardForm.StatusLabel.Refresh;
    Sleep(3000);
    Waited := Waited + 3;
    Result := DockerEngineReady();
  end;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  DamcStarted := False;
  DockerReady := DockerEngineReady();
  DockerDesktopFound := DockerReady or DockerDesktopInstalled();
  if not DockerDesktopFound then
  begin
    // Case C. Say what is missing and why, offer the OFFICIAL page (never a
    // bundled binary), then let the user install DAMC now and come back.
    if SuppressibleMsgBox(FmtMessage(CustomMessage('DockerMissingBody'), ['{#DockerURL}']),
                          mbConfirmation, MB_YESNO, IDNO) = IDYES then
      ShellExec('open', '{#DockerURL}', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    if SuppressibleMsgBox(CustomMessage('DockerMissingContinue'),
                          mbConfirmation, MB_YESNO, IDYES) = IDNO then
      Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  LogPath: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  // Case B: bring the engine up before starting DAMC.
  if DockerDesktopFound and (not DockerReady) then
  begin
    WizardForm.StatusLabel.Caption := CustomMessage('DockerStarting');
    WizardForm.StatusLabel.Refresh;
    DockerReady := WaitForDocker(180);
    if not DockerReady then
      SuppressibleMsgBox(CustomMessage('DockerNotReady'), mbInformation, MB_OK, IDOK);
  end;

  if not DockerReady then
    Exit;

  // Start DAMC hidden. The launcher runs damc-start.cmd with no window and, in
  // nogui mode, reports only through its exit code - so a silent install can
  // never block on a dialog. The status line is the user's only feedback; the
  // first install loads the Docker images here, which is the slow part.
  WizardForm.StatusLabel.Caption := CustomMessage('DamcPreparing');
  WizardForm.StatusLabel.Refresh;
  if Exec(ExpandConstant('{sys}\wscript.exe'),
          '"' + ExpandConstant('{app}\scripts\damc-launch.vbs') + '" start nogui',
          ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    DamcStarted := (ResultCode = 0)
  else
    DamcStarted := False;
  if not DamcStarted then
  begin
    LogPath := ExpandConstant('{localappdata}\DAMC\logs\damc-start.log');
    SuppressibleMsgBox(FmtMessage(CustomMessage('StartFailed'), [IntToStr(ResultCode), LogPath]),
                       mbInformation, MB_OK, IDOK);
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // The browser offer only makes sense if DAMC is actually up.
  if CurPageID = wpFinished then
  begin
    if WizardForm.RunList.Items.Count > 0 then
      WizardForm.RunList.Checked[0] := DamcStarted;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Default is to keep the user's memories. Removing them is opt-in.
    if SuppressibleMsgBox(CustomMessage('UninstallKeepData'),
                          mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
    begin
      Exec(ExpandConstant('{cmd}'),
           '/c ""' + ExpandConstant('{app}\scripts\damc-uninstall-cleanup.cmd') + '" purge"',
           ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;
