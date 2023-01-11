import * as tfc from '@tensorflow/tfjs-core';
import * as tfl from '@tensorflow/tfjs-layers';

import { Activation, getActivation, serializeActivation } from '@tensorflow/tfjs-layers/dist/activations';
import { Initializer, getInitializer, serializeInitializer } from '@tensorflow/tfjs-layers/dist/initializers';
import { Constraint, getConstraint, serializeConstraint } from '@tensorflow/tfjs-layers/dist/constraints';
import { Regularizer, getRegularizer, serializeRegularizer } from '@tensorflow/tfjs-layers/dist/regularizers';
import { getExactlyOneShape, getExactlyOneTensor } from '@tensorflow/tfjs-layers/dist/utils/types_utils';

import {
    ActivationId, InitializerId, ConstraintId, RegularizerId
} from './keras_format';
import { nullWrapper, undefinedWrapper } from './tfjs_fix';
import { Kwargs } from '@tensorflow/tfjs-layers/dist/types';

export declare interface EinsumDenseLayerArgs {
    equation: string,
    output_shape: number | [number],
    activation?: ActivationId,
    bias_axes?: string,
    kernelInitializer?: InitializerId,
    biasInitializer?: InitializerId,
    kernelRegularizer?: RegularizerId,
    biasRegularizer?: RegularizerId,
    activityRegularizer?: RegularizerId,
    kernelConstraint?: ConstraintId,
    biasConstraint?: ConstraintId
};

export class EinsumDense extends tfl.layers.Layer {

    equation: string;
    partialOutputShape: tfl.Shape;
    fullOutputShape?: tfl.Shape;
    kernel?: tfl.LayerVariable;
    bias?: tfl.LayerVariable;
    biasAxes?: string;
    activation: Activation;
    kernelInitializer: Initializer;
    biasInitializer: Initializer;
    kernelRegularizer?: Regularizer;
    biasRegularizer?: Regularizer;
    kernelConstraint?: Constraint;
    biasConstraint?: Constraint;
    
    constructor(args: EinsumDenseLayerArgs) {
        super();
        
        this.equation = args.equation;
        if (typeof args.output_shape === "number")
            this.partialOutputShape = [args.output_shape];
        else
            this.partialOutputShape = args.output_shape;
        this.biasAxes = args.bias_axes;
        this.activation = getActivation(args.activation || "linear");
        this.kernelInitializer = getInitializer(args.kernelInitializer || "glorotUniform");
        this.biasInitializer = getInitializer(args.biasInitializer || "zeros");

        this.kernelRegularizer = undefinedWrapper(getRegularizer, args.kernelRegularizer);
        this.biasRegularizer = undefinedWrapper(getRegularizer, args.biasRegularizer);
        
        this.kernelConstraint = undefinedWrapper(getConstraint, args.kernelConstraint);
        this.biasConstraint = undefinedWrapper(getConstraint, args.biasConstraint);
    }

    override build(inputShape: tfl.Shape | tfl.Shape[]): void {
        const oneShape = getExactlyOneShape(inputShape);
        const shapeData = analyzeEinsumString(
            this.equation, this.biasAxes, oneShape, this.partialOutputShape
        );

        const { weightShape, outputShape, biasShape } = shapeData;
        this.fullOutputShape = outputShape;
        this.kernel = this.addWeight(
            "kernel",
            weightShape,
            this.dtype,
            this.kernelInitializer,
            this.kernelRegularizer,
            true,
            this.kernelConstraint
        );
        
        if (biasShape != null) {
            this.bias = this.addWeight(
                "bias",
                biasShape,
                this.dtype,
                this.biasInitializer,
                this.biasRegularizer,
                true,
                this.biasConstraint,
            );
        }

        super.build(inputShape);
    }

    override computeOutputShape(
        inputShape: tfl.Shape | tfl.Shape[]
    ): tfl.Shape | tfl.Shape[] {
        return <tfl.Shape>this.fullOutputShape;
    }

    override getConfig(): tfc.serialization.ConfigDict {
        const config = {
            outputShape: this.partialOutputShape,
            equation: this.equation,
            "activation": serializeActivation(this.activation),
            "biasAxes": this.biasAxes || null,
            "kernelInitializer": serializeInitializer(this.kernelInitializer),
            "biasInitializer": serializeInitializer(this.biasInitializer),
            "kernelRegularizer": nullWrapper(serializeRegularizer, this.kernelRegularizer),
            "biasRegularizer": nullWrapper(serializeRegularizer, this.biasRegularizer),
            "activityRegularizer": nullWrapper(serializeRegularizer, this.activityRegularizer),
            "kernelConstraint": nullWrapper(serializeConstraint, this.kernelConstraint),
            "biasConstraint": nullWrapper(serializeConstraint, this.biasConstraint)
        };

        const baseConfig = super.getConfig();

        return {...baseConfig, ...config};
    }

    override call(
        inputs: tfc.Tensor<tfc.Rank> | tfc.Tensor<tfc.Rank>[], kwargs: Kwargs
    ): tfc.Tensor<tfc.Rank> | tfc.Tensor<tfc.Rank>[] {
        return tfc.tidy(() => {
            const tensor = getExactlyOneTensor(inputs);

            let ret = tfc.einsum(this.equation, tensor, this.kernel!.read());
            if (this.bias !== undefined) ret = tfc.add(ret, this.bias.read());
            if (this.activation !== undefined) ret = this.activation.apply(ret);
            
            return ret;
        });
    }

    static get className(): string {
        return "EinsumDense";
    }
}

tfc.serialization.registerClass(EinsumDense);

export interface SplitStringResult {
    weightShape: tfl.Shape,
    biasShape?: tfl.Shape,
    outputShape: tfl.Shape
}

export function analyzeEinsumString(
    equation: string,
    biasAxes: string | undefined,
    inputShape: tfl.Shape,
    outputShape: tfl.Shape,
): SplitStringResult {
    const dotReplacedString = equation.replace(/\.\.\./g, '0');

    let splitString = dotReplacedString.match(/^([a-zA-Z]+),([a-zA-Z]+)->([a-zA-Z]+)$/);
    if (splitString) {
        return analyzeSplitString(
            splitString, biasAxes, inputShape, outputShape
        );
    }

    splitString = dotReplacedString.match(/^0([a-zA-Z]+),([a-zA-Z]+)->0([a-zA-Z]+)$/);
    if (splitString) {
        return analyzeSplitString(splitString, biasAxes, inputShape, outputShape, true);
    }

    splitString = dotReplacedString.match(/^([a-zA-Z]{2,})0,([a-zA-Z]+)->([a-zA-Z]+)0$/);
    if (splitString) {
        return analyzeSplitString(splitString, biasAxes, inputShape, outputShape);
    }

    throw new Error(
        `Invalid einsum equation '${equation}'. Equations must be in the form` +
        ` [X],[Y]->[Z], ...[X],[Y]->...[Z], or [X]...,[Y]->[Z]....`
    );
}

function analyzeSplitString(
    splitString: RegExpMatchArray,
    biasAxes: string | undefined,
    inputShape: tfl.Shape,
    outputShape: tfl.Shape,
    leftElided: boolean = false
): SplitStringResult {
    const inputSpec = splitString[1];
    const weightSpec = splitString[2];
    const outputSpec = splitString[3];
    const elided = inputShape.length - outputShape.length;

    outputShape.unshift(inputShape[0]);

    if (elided > 0 && leftElided) {
        for (let i = 1; i < elided; i++) {
            outputShape.splice(1, 0, inputShape[i]);
        }
    } else if (elided > 0 && !leftElided) {
        for (let i = inputShape.length - elided; i < inputShape.length; i++) {
            outputShape.push(inputShape[i]);
        }
    }

    const inputDimMap: { [key: string]: number; } = {};
    const outputDimMap: { [key: string]: number; } = {}
    if (leftElided) {
        [...inputSpec].forEach((dim, i) => inputDimMap[dim] = i + elided - inputShape.length);
        [...outputSpec].forEach((dim, i) => outputDimMap[dim] = i + elided);
    } else {
        [...inputSpec].forEach((dim, i) => inputDimMap[dim] = i);
        [...outputSpec].forEach((dim, i) => outputDimMap[dim] = i);
    }

    for (let dim of inputSpec) {
        const inputShapeAtDim = inputShape[inputDimMap[dim]];

        if (dim in outputDimMap) {
            const outputShapeAtDim = outputShape[outputDimMap[dim]];
            if (outputShapeAtDim != null && outputShapeAtDim !== inputShapeAtDim) {
                throw new Error(
                    `Input shape and output shape do not match at shared ` + 
                    `dimension '${dim}'. Input shape is ${inputShapeAtDim}, ` +
                    `and output shape ` +
                    `is ${outputShape[outputDimMap[dim]]}.`
                );
            }
        }
    }

    for (let dim of outputSpec) {
        if (!inputSpec.includes(dim) && !weightSpec.includes(dim)) {
            throw new Error(
                `Dimension '${dim}' was specified in the output ` +
                `'${outputSpec}' but has no corresponding dim in the input ` +
                `spec '${inputSpec}' or weight spec '${outputSpec}'`
            )
        }
    }

    const weightShape = [];
    for (let dim of weightSpec) {
        if (dim in inputDimMap) weightShape.push(inputShape[inputDimMap[dim]]);
        else if (dim in outputDimMap) weightShape.push(outputShape[outputDimMap[dim]]);
        else throw new Error(
            `Weight dimension '${dim}' did not have a match in either ` +
            `the input spec '${inputSpec}' or the output ` +
            `spec '${outputSpec}'. For this layer, the weight must ` +
            `be fully specified.`
        );
    }

    let biasShape: tfl.Shape | undefined;
    if (biasAxes != null) {
        const numLeftElided = leftElided ? elided : 0;
        const idxMap: { [key: string]: number } = {};
        [...outputSpec].forEach((char, i) => idxMap[char] = i + numLeftElided);

        for (let char of biasAxes) {
            if (!outputSpec.includes(char)) {
                throw new Error(
                    `Bias dimension '${char}' was requested, but is not part ` +
                    `of the output spec '${outputSpec}'`
                );
            }
        }

        const firstBiasLocation = Math.min(
            ...[...biasAxes].map(char => outputSpec.indexOf(char))
        );
        const biasOutputSpec = outputSpec.slice(firstBiasLocation);

        biasShape = [...biasOutputSpec].map(
            char => biasAxes.includes(char) ? idxMap[char] : 1
        );

        if (!leftElided) {
            biasShape = [...biasShape, ...new Array(elided).fill(1)];
        }
    }

    return { weightShape, outputShape, biasShape };
}
