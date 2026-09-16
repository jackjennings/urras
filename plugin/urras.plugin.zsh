0=${(%):-%N}
urras_bin_dir="${0:A:h}/../bin"
[[ ":$PATH:" == *":$urras_bin_dir:"* ]] || export PATH="$urras_bin_dir:$PATH"
unset urras_bin_dir

alias utk='ur tick'
alias uap='ur approve'
alias ust='ur status'
alias uen='ur enable'
alias udi='ur disable'
alias udo='ur doctor'
alias uco='ur completion'
alias urt='ur retry'
alias udc='ur decline'
alias urw='ur rewind'
alias urv='ur review'
alias ush='ur shell'
alias uta='ur tail'
alias uup='ur update'
alias uhd='ur hud'
alias uus='ur usage'
alias uca='ur capture'
alias ubr='ur brainstorm'
alias uho='ur hold'
alias ure='ur resume'
alias upr='ur prioritize'
alias ude='ur deprioritize'

source <(ur completion zsh)

compdef uap=ur
compdef urt=ur
compdef udc=ur
compdef urw=ur
compdef urv=ur
compdef ush=ur
compdef uta=ur
compdef uho=ur
compdef ure=ur
compdef upr=ur
compdef ude=ur
