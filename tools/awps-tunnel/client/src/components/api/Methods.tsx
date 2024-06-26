import 'bootstrap/dist/css/bootstrap.min.css';
import './Methods.css'
import React, {useEffect, useState} from "react";
import {Example, Operation, APIResponse} from "../../models";
import {Response} from "./Response";
import {Parameters} from "./Parameters";
import {Label} from "@fluentui/react-components";

export function Method({method, path, methodName}: {
	method: Operation,
	path: string,
	methodName: string
}): React.JSX.Element {
	const [example, setExample] = useState<Example>();
	const [response, setResponse] = useState<APIResponse | undefined>(undefined);
	useEffect(() => {
		const operationId = method.operationId;
		const example = method["x-ms-examples"][operationId].$ref;
		fetch(example).then(res => res.json()).then(res => setExample(res))
		setResponse(undefined);
	}, [method, path]);
	
	return (
		<div className="d-flex">
			<div className="p-3">
				<Label className="fs-4 fw-bold ms-2">{method.summary}</Label>
				
				<div className="d-flex flex-row justify-content-start align-items-center ms-2">
					<div className={"method-tag"}>{methodName.toUpperCase()}
					</div>
					<div className="mx-2">{path}</div>
				</div>
				
				
				{method.parameters && example &&
			<Parameters path={path} parameters={method.parameters} example={example.parameters}
			            setResponse={setResponse} methodName={methodName}/>}
				<Response responseSchema={method.responses} response={response}/>
			</div>
		</div>
	)
}
