' DAMC launcher.
'
' What the Start Menu, the desktop shortcut and the installer run. It starts DAMC
' with NO window at all - damc-start.cmd runs with window style 0 - and the only
' thing a person ever sees is either the browser opening, or one dialog that says
' what failed and offers the log. The developer-facing output ("Loading DAMC
' images...", compose progress) lives in the log file, never on screen.
'
'   wscript damc-launch.vbs open    start if needed, then open the dashboard  (shortcuts)
'   wscript damc-launch.vbs start   start if needed, no browser               (installer)
'   wscript damc-launch.vbs stop    stop the containers, keep the data
'
' A second argument "nogui" (or the DAMC_NO_GUI environment variable) suppresses the
' dialog: the exit code is returned and the caller reports instead. The installer
' uses that so an unattended install never blocks on a dialog nobody can answer.
'
' Encoding: this file is Windows-949 (the system code page), on purpose.
Option Explicit

Dim sh, fso, env, mode, nogui, base, log, code, msg, ans
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set env = sh.Environment("Process")

base = fso.GetParentFolderName(WScript.ScriptFullName)
log  = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DAMC\logs\damc-start.log"

mode = "open"
If WScript.Arguments.Count > 0 Then mode = LCase(WScript.Arguments(0))
nogui = False
If WScript.Arguments.Count > 1 Then nogui = (LCase(WScript.Arguments(1)) = "nogui")
If env("DAMC_NO_GUI") <> "" Then nogui = True

If mode = "stop" Then
  code = sh.Run("cmd.exe /c """"" & base & "\damc-stop.cmd""""", 0, True)
  WScript.Quit code
End If

' Already running? Then "open" is just the browser - no script, no Docker calls.
If mode = "open" And Healthy() Then
  sh.Run "http://127.0.0.1:8787", 1, False
  WScript.Quit 0
End If

' Hidden start. Window style 0: no console is created at all.
code = sh.Run("cmd.exe /c """"" & base & "\damc-start.cmd"" --no-pause""", 0, True)

If code = 0 Then
  If mode = "open" Then sh.Run "http://127.0.0.1:8787", 1, False
  WScript.Quit 0
End If

Select Case code
  Case 2: msg = "Docker Desktop을 시작할 수 없습니다." & vbCrLf & "Docker Desktop 창에 ""Engine running""이 표시된 뒤 DAMC를 다시 실행하세요."
  Case 3: msg = "DAMC를 실행하려면 Docker Desktop이 필요합니다." & vbCrLf & "설치: https://www.docker.com/products/docker-desktop/"
  Case 4: msg = "DAMC 구성요소를 준비하지 못했습니다. (Docker image load 실패)"
  Case 5, 6: msg = "DAMC 데이터베이스를 준비하지 못했습니다."
  Case 7: msg = "DAMC를 시작하지 못했습니다."
  Case 8: msg = "DAMC가 응답하지 않습니다. (http://127.0.0.1:8787)"
  Case Else: msg = "DAMC를 시작하지 못했습니다. (코드 " & code & ")"
End Select

If nogui Then
  WScript.Quit code
End If

ans = MsgBox(msg & vbCrLf & vbCrLf & "자세한 내용은 로그에 있습니다. 로그를 열까요?", vbYesNo + vbExclamation, "DAMC")
If ans = vbYes Then sh.Run "notepad.exe """ & log & """", 1, False
WScript.Quit code

' GET /health with a short timeout. Any failure - refused, timeout, non-200 - is "not running".
Function Healthy()
  On Error Resume Next
  Healthy = False
  Dim http
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.open "GET", "http://127.0.0.1:8787/health", False
  http.send
  If Err.Number = 0 Then
    If http.Status = 200 Then Healthy = True
  End If
  On Error GoTo 0
End Function
