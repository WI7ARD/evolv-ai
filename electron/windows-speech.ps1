param([string]$Culture = "")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Send-VoiceEvent([hashtable]$Payload) {
  [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Speech
  $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $recognizerInfo = if ($Culture) {
    $recognizers | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1
  } else {
    $recognizers | Select-Object -First 1
  }
  if (-not $recognizerInfo) {
    throw "No compatible Windows speech recognizer is installed."
  }

  # The parameterless constructor selects Windows' default in-process engine.
  # Some Windows 11 installations enumerate an engine ID that cannot be opened
  # explicitly even though the default engine works correctly.
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new()
  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(12)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(4)
  $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(650)
  $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(900)
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToDefaultAudioDevice()

  $recognizer.add_SpeechHypothesized({
    param($Sender, $Event)
    if ($Event.Result.Text) {
      Send-VoiceEvent @{ type = "partial"; text = $Event.Result.Text }
    }
  })
  $recognizer.add_SpeechRecognized({
    param($Sender, $Event)
    if ($Event.Result.Text) {
      Send-VoiceEvent @{
        type = "transcript"
        text = $Event.Result.Text
        confidence = [Math]::Round($Event.Result.Confidence, 3)
      }
    }
  })
  $recognizer.add_SpeechRecognitionRejected({
    Send-VoiceEvent @{ type = "rejected" }
  })

  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Send-VoiceEvent @{
    type = "ready"
    culture = $recognizerInfo.Culture.Name
    recognizer = $recognizerInfo.Description
  }

  while ($true) {
    $command = [Console]::In.ReadLine()
    if ($null -eq $command -or $command.Trim().ToLowerInvariant() -eq "stop") { break }
  }
} catch {
  Send-VoiceEvent @{ type = "error"; error = $_.Exception.Message }
  exit 1
} finally {
  if ($recognizer) {
    try { $recognizer.RecognizeAsyncCancel() } catch {}
    try { $recognizer.Dispose() } catch {}
  }
}
